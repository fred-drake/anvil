import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
	AnvilCheckpoint,
	EngineExecOptions,
	EngineExecResult,
	EngineHost,
	ReviewSubagentRunRequest,
	ReviewSubagentRunResult,
	RunSummary,
} from "../src/engine.ts";
import { ReviewSubagentUnavailableError } from "../src/errors.ts";
import { executeAgentCheck, executeDeterministicCheck, VerdictBus, type Verdict } from "../src/gates.ts";
import { buildIndependentReviewTask, renderCommandTemplateString, renderTemplateString } from "../src/prompts.ts";
import { INDEPENDENT_REVIEW_FAIL_REASON } from "../src/subagent/child.ts";
import type { AgentCheck, WorkflowDefinition } from "../src/types.ts";

const execFileAsync = promisify(execFile);

class GateHost implements EngineHost {
	instructions: string[] = [];
	execResult: EngineExecResult = { stdout: "", stderr: "", code: 0 };
	execCalls: Array<{ command: string; args: string[]; options?: EngineExecOptions }> = [];
	verdict: Verdict | undefined;
	verdictQueue: Array<Verdict | undefined> = [];
	neverVerdict = false;
	turns = 0;
	reviewRequests: ReviewSubagentRunRequest[] = [];
	runReviewSubagent?: (request: ReviewSubagentRunRequest, signal?: AbortSignal) => Promise<ReviewSubagentRunResult>;

	sendInstruction(instruction: string): void {
		this.instructions.push(instruction);
	}

	async waitForTurnComplete(): Promise<void> {
		this.turns += 1;
	}

	async exec(command: string, args: string[], options?: EngineExecOptions): Promise<EngineExecResult> {
		this.execCalls.push({ command, args, options });
		return this.execResult;
	}

	async awaitVerdict(checkId: string, _timeoutMs?: number, _signal?: AbortSignal): Promise<Verdict | undefined> {
		if (this.neverVerdict) return new Promise(() => undefined);
		if (this.verdictQueue.length > 0) {
			const verdict = this.verdictQueue.shift();
			return verdict ? { ...verdict, checkId } : undefined;
		}
		return this.verdict ? { ...this.verdict, checkId } : undefined;
	}

	checkpoint(_entry: AnvilCheckpoint): void {}
	notify(): void {}
	setStatus(): void {}
	setWidget(): void {}
	postSummary(_summary: RunSummary): void {}
}

class RealExecHost extends GateHost {
	override async exec(command: string, args: string[], options?: EngineExecOptions): Promise<EngineExecResult> {
		this.execCalls.push({ command, args, options });
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const execError = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
			return {
				stdout: execError.stdout ?? "",
				stderr: execError.stderr ?? execError.message ?? "",
				code: execError.code ?? 1,
				killed: execError.killed,
			};
		}
	}
}

class TurnFirstRepromptHost extends GateHost {
	verdictTimeouts: number[] = [];

	override async awaitVerdict(checkId: string, timeoutMs = 0): Promise<Verdict | undefined> {
		this.verdictTimeouts.push(timeoutMs);
		if (this.verdictTimeouts.length === 1) {
			return new Promise((resolve) => setTimeout(() => resolve(undefined), 1));
		}
		return { checkId, pass: true, reason: "fresh verdict after reprompt" };
	}

	override async waitForTurnComplete(): Promise<void> {
		this.turns += 1;
		if (this.turns === 1) return;
		return new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("VerdictBus", () => {
	it("resolves matching verdicts", async () => {
		const bus = new VerdictBus();
		const pending = bus.awaitVerdict("check", 1000);

		expect(bus.reportVerdict("check", true, "ok")).toBe(true);
		await expect(pending).resolves.toEqual({ checkId: "check", pass: true, reason: "ok" });
	});

	it("ignores stale verdict ids", () => {
		const bus = new VerdictBus();
		expect(bus.reportVerdict("missing", false, "late")).toBe(false);
	});

	it("resolves undefined on timeout or clear", async () => {
		const bus = new VerdictBus();
		await expect(bus.awaitVerdict("timeout", 1)).resolves.toBeUndefined();

		const pending = bus.awaitVerdict("clear", 1000);
		bus.clear();
		await expect(pending).resolves.toBeUndefined();
	});

	it("replaces duplicate waiters for the same check id", async () => {
		const bus = new VerdictBus();
		const first = bus.awaitVerdict("check", 1000);
		const second = bus.awaitVerdict("check", 1000);

		await expect(first).resolves.toBeUndefined();
		expect(bus.reportVerdict("check", false, "retry")).toBe(true);
		await expect(second).resolves.toEqual({ checkId: "check", pass: false, reason: "retry" });
	});

	it("rejects verdict waits when aborted", async () => {
		const bus = new VerdictBus();
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(bus.awaitVerdict("pre", 1000, alreadyAborted.signal)).rejects.toThrow("Anvil run aborted");

		const controller = new AbortController();
		const pending = bus.awaitVerdict("during", 1000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Anvil run aborted");
	});
});

describe("executeDeterministicCheck", () => {
	it("maps exit code 0 to pass", async () => {
		const host = new GateHost();
		host.execResult = { stdout: "ok", stderr: "", code: 0 };

		const result = await executeDeterministicCheck({
			host,
			check: { type: "deterministic", command: "true" },
			ctx: ctx(),
			checkId: "check",
		});

		expect(result.pass).toBe(true);
	});

	it("maps non-zero exit codes to failure reasons", async () => {
		const host = new GateHost();
		host.execResult = { stdout: "", stderr: "bad", code: 2 };

		const result = await executeDeterministicCheck({
			host,
			check: { type: "deterministic", command: "false" },
			ctx: ctx(),
			checkId: "check",
		});

		expect(result.pass).toBe(false);
		expect(result.reason).toContain("bad");
	});

	it("renders templated command options and tails long failure output", async () => {
		const host = new GateHost();
		host.execResult = { stdout: "x".repeat(2100), stderr: "", code: 1 };
		const controller = new AbortController();

		const result = await executeDeterministicCheck({
			host,
			check: { type: "deterministic", id: "id", name: "Named", command: (context) => `echo ${context.input}`, cwd: "/work", timeoutMs: 12 },
			ctx: ctx(),
			checkId: "check",
			signal: controller.signal,
		});

		expect(result.name).toBe("Named");
		expect(result.reason).toHaveLength(2000);
		expect(host.execCalls[0]).toEqual({
			command: "bash",
			args: ["-c", "echo task"],
			options: { cwd: "/work", timeout: 12, signal: controller.signal },
		});
	});

	it("renders command placeholders through shell variables", async () => {
		const host = new GateHost();
		const maliciousInput = "report.txt; touch /tmp/pwned $(echo still-data) 'quote'";

		await executeDeterministicCheck({
			host,
			check: { type: "deterministic", command: "test -f {input} && echo loop={loop}" },
			ctx: ctx(maliciousInput, { "check->one": 2 }),
			checkId: "check",
		});

		const expectedCommand = [
			String.raw`__ANVIL_INPUT='report.txt; touch /tmp/pwned $(echo still-data) '\''quote'\''' __ANVIL_LOOP='2'; test -f "`,
			"${__ANVIL_INPUT}",
			String.raw`" && echo loop="`,
			"${__ANVIL_LOOP}",
			'"',
		].join("");
		expect(host.execCalls[0]?.args[1]).toBe(expectedCommand);
	});

	it("does not evaluate command substitutions inside double-quoted placeholders", async () => {
		const root = mkdtempSync(join(tmpdir(), "anvil-quoted-placeholder-"));
		try {
			const pwnedFile = join(root, "pwned");
			const host = new RealExecHost();

			const result = await executeDeterministicCheck({
				host,
				check: { type: "deterministic", command: String.raw`printf '%s\n' "{input}" >/dev/null` },
				ctx: ctx(`$(touch ${pwnedFile})`),
				checkId: "check",
			});

			expect(result.pass).toBe(true);
			expect(existsSync(pwnedFile)).toBe(false);
			expect(host.execCalls[0]?.args[1]).toContain('"${__ANVIL_INPUT}"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("expands placeholders safely from single-quoted command text", async () => {
		const host = new RealExecHost();
		const input = "two words; $(echo not-run)";

		const result = await executeDeterministicCheck({
			host,
			check: { type: "deterministic", command: String.raw`printf '%s' '{input}'` },
			ctx: ctx(input),
			checkId: "check",
		});

		expect(result.pass).toBe(true);
		expect(result.output).toBe(input);
	});

	it("keeps normal prompt templating unescaped", () => {
		expect(renderTemplateString("Do {input}", ctx("a && b"))).toBe("Do a && b");
	});

	it("renders prior step outputs in prompt templates and leaves missing outputs empty", () => {
		expect(renderTemplateString("Plan: {outputs.plan}; Missing: {outputs.missing}", ctx("task", {}, { plan: "use the cache" }))).toBe(
			"Plan: use the cache; Missing: ",
		);
	});

	it("does not re-expand output placeholders that appear inside a substituted value", () => {
		expect(
			renderTemplateString("Task: {input}; Plan: {outputs.plan}", ctx("{outputs.plan}", {}, { plan: "secret" })),
		).toBe("Task: {outputs.plan}; Plan: secret");
	});

	it("renders output placeholders in command templates through shell variables", async () => {
		const host = new GateHost();
		const output = "two words; $(echo not-run) 'quote'";

		await executeDeterministicCheck({
			host,
			check: { type: "deterministic", command: "printf '%s' '{outputs.plan}' && printf '%s' {outputs.missing}" },
			ctx: ctx("task", {}, { plan: output }),
			checkId: "check",
		});

		expect(host.execCalls[0]?.args[1]).toContain(String.raw`__ANVIL_OUTPUT_0='two words; $(echo not-run) '\''quote'\'''`);
		expect(host.execCalls[0]?.args[1]).toContain("${__ANVIL_OUTPUT_0}");
		expect(host.execCalls[0]?.args[1]).toContain("__ANVIL_OUTPUT_1=''");
	});

	it("renders forEach item placeholders in prompt templates", () => {
		const itemCtx = { ...ctx("task"), item: "src/foo.ts", itemIndex: 2, itemCount: 5 };
		expect(renderTemplateString("stub {item} ({itemIndex}/{itemCount}) for {input}", itemCtx)).toBe(
			"stub src/foo.ts (2/5) for task",
		);
	});

	it("expands forEach item placeholders to empty strings outside a forEach step", () => {
		expect(renderTemplateString("[{item}] index={itemIndex} count={itemCount}", ctx("task"))).toBe(
			"[] index= count=",
		);
	});

	it("injects a hostile item string into a command through a shell variable, not raw interpolation", () => {
		const hostile = "foo.ts; touch /tmp/pwned $(echo x) 'q'\nsecond";
		const itemCtx = { ...ctx("task"), item: hostile, itemIndex: 0, itemCount: 1 };
		const rendered = renderCommandTemplateString("npx vitest run {item}", itemCtx);

		expect(rendered).toContain('__ANVIL_ITEM=');
		expect(rendered).toContain('npx vitest run "${__ANVIL_ITEM}"');
		// The literal payload appears only inside the quoted assignment, never as bare shell text.
		expect(rendered).not.toContain("touch /tmp/pwned $(echo x) 'q'\nsecond npx");
	});

	it("reflects the current item's loop count in {loop} inside a forEach step", () => {
		const itemCtx = { ...ctx("task", { "tests->fanout#3": 2 }), item: "x", itemIndex: 3, itemCount: 4, step: { id: "fanout", index: 0 } };
		expect(renderCommandTemplateString("echo loop={loop}", itemCtx)).toContain("__ANVIL_LOOP='2'");
	});
});

describe("executeAgentCheck", () => {
	it("routes reviewed checks without self-grading or propagating reviewer prose", async () => {
		const host = new GateHost();
		const secret = "unmarked-reviewer-secret";
		host.runReviewSubagent = async (request) => {
			host.reviewRequests.push(request);
			return { pass: false, reason: `missing regression test: ${secret}`, sessionFile: "/tmp/review.jsonl", exitCode: 0 };
		};

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "cmux" } },
			ctx: ctx(),
			checkId: "run:one:0:0",
		});

		expect(result).toMatchObject({
			pass: false,
			reason: INDEPENDENT_REVIEW_FAIL_REASON,
			checkId: "run:one:0:0",
			timeoutMs: 1_800_000,
		});
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(host.reviewRequests).toHaveLength(1);
		expect(host.reviewRequests[0]?.timeoutMs).toBe(1_800_000);
		expect(host.instructions).toEqual([]);
		expect(host.turns).toBe(0);
	});

	it("bounds review request identities before crossing the launcher boundary", async () => {
		const hostileIdentity = `${"identity\u0000\n\u001b[31m".repeat(150_000)}REQUEST_ID_CANARY`;
		const host = new GateHost();
		host.runReviewSubagent = async (request) => {
			host.reviewRequests.push(request);
			return { pass: true, reason: "review passed", sessionFile: "/tmp/review.jsonl", exitCode: 0 };
		};
		const definition = workflow();

		await executeAgentCheck({
			host,
			workflow: { ...definition, name: hostileIdentity },
			step: { ...definition.steps[0]!, id: hostileIdentity },
			check: { type: "agent", prompt: "criteria", review: { subagent: "cmux" } },
			ctx: ctx(),
			checkId: `run:${hostileIdentity}:0:0`,
			runId: hostileIdentity,
		});

		const request = host.reviewRequests[0]!;
		for (const identity of [request.runId, request.workflowName, request.stepId, request.checkId]) {
			expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/u);
			expect(Buffer.byteLength(identity, "utf8")).toBeLessThanOrEqual(256);
			expect(identity).not.toMatch(/[\u0000-\u001f\u007f]/u);
			expect(identity).not.toContain("REQUEST_ID_CANARY");
		}
		expect(Buffer.byteLength(request.task, "utf8")).toBeLessThan(20_000);
	});

	it("fails closed with a gate result when an independent review backend is unavailable, unless main fallback is explicit", async () => {
		const unavailable = new GateHost();
		const required = await executeAgentCheck({
			host: unavailable,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "herdr" } },
			ctx: ctx(),
			checkId: "required-review",
		});
		expect(required).toMatchObject({
			checkId: "required-review",
			pass: false,
			reason: 'Independent review backend "herdr" is unavailable.',
			timeoutMs: 1_800_000,
		});
		expect(unavailable.instructions).toEqual([]);

		const automatic = await executeAgentCheck({
			host: unavailable,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "auto" } },
			ctx: ctx(),
			checkId: "automatic-review",
		});
		expect(automatic).toMatchObject({
			pass: false,
			reason: 'Independent review backend "auto" is unavailable.',
		});

		const fallback = new GateHost();
		fallback.verdict = { checkId: "ignored", pass: true, reason: "explicit fallback" };
		const optional = await executeAgentCheck({
			host: fallback,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "herdr" }, reviewFallback: "main" },
			ctx: ctx(),
			checkId: "fallback-review",
		});
		expect(optional).toMatchObject({ pass: true, reason: "explicit fallback" });
		expect(fallback.instructions).toHaveLength(1);
	});

	it("returns a failed gate or uses explicit main fallback when the backend becomes unavailable at review launch", async () => {
		const required = new GateHost();
		required.runReviewSubagent = async () => {
			throw new ReviewSubagentUnavailableError();
		};
		const requiredResult = await executeAgentCheck({
			host: required,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "cmux" }, timeoutMs: 4321 },
			ctx: ctx(),
			checkId: "required-runtime-review",
		});
		expect(requiredResult).toMatchObject({
			checkId: "required-runtime-review",
			pass: false,
			reason: 'Independent review backend "cmux" is unavailable.',
			timeoutMs: 4321,
		});
		expect(required.instructions).toEqual([]);

		const host = new GateHost();
		host.verdict = { checkId: "ignored", pass: true, reason: "explicit runtime fallback" };
		host.runReviewSubagent = async () => {
			throw new ReviewSubagentUnavailableError();
		};

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "cmux" }, reviewFallback: "main" },
			ctx: ctx(),
			checkId: "runtime-fallback",
		});

		expect(result).toMatchObject({ pass: true, reason: "explicit runtime fallback" });
		expect(host.reviewRequests).toEqual([]);
		expect(host.instructions).toHaveLength(1);
		expect(host.turns).toBe(1);
	});

	it("does not self-grade review launch or transport failures", async () => {
		const host = new GateHost();
		host.verdict = { checkId: "ignored", pass: true, reason: "rubber stamp" };
		host.runReviewSubagent = async () => {
			throw new Error("Independent review verdict sidecar is malformed");
		};

		await expect(executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria", review: { subagent: "cmux" }, reviewFallback: "main" },
			ctx: ctx(),
			checkId: "transport-failure",
		})).rejects.toThrow("Independent review verdict sidecar is malformed");
		expect(host.instructions).toEqual([]);
		expect(host.turns).toBe(0);
	});

	it("builds an independent reviewer task with only the documented reviewer contract", async () => {
		const definition = workflow();
		const step = {
			...definition.steps[0]!,
			prompt: "EXECUTOR_PROMPT_MUST_NOT_REACH_REVIEWER",
		};
		const task = await buildIndependentReviewTask({
			workflow: definition,
			step,
			check: { type: "agent", prompt: "Inspect {input}" },
			ctx: ctx("checked-in artifacts"),
			checkId: "run:one:0:0",
		});

		expect(task).toContain(`workflow "${definition.name}", step "${step.id}"`);
		expect(task).toContain("Evaluation criteria:\nInspect checked-in artifacts");
		expect(task).toMatch(/inspect artifacts directly/i);
		expect(task).toMatch(/read-only filesystem tools/i);
		expect(task).toMatch(/realpath-resolved workflow cwd/i);
		expect(task).toMatch(/deny secret-like paths and symlink escapes/i);
		expect(task).toContain("Submit exactly one `anvil_verdict` tool call");
		expect(task).toContain("check_id `run:one:0:0`");
		expect(task).toContain("pass true only when all criteria are satisfied");
		expect(task).toContain("a concise reason");
		expect(task).not.toContain("EXECUTOR_PROMPT_MUST_NOT_REACH_REVIEWER");
		expect(task).not.toMatch(/executor (?:conversation|transcript)|internal reasoning/i);
	});

	it("sanitizes credentials in independent-review criteria and observable results", async () => {
		const npmToken = "npm_super_secret_token_value_123456789";
		const databaseUrls = [
			"postgresql://admin:database-password@db.example.test/app",
			"mysql://quoted-user:quoted-password@db.example.test/app",
			"mongodb://json-user:json-password@db.example.test/app",
		];
		const secretInput = [
			`NPM_TOKEN=${npmToken}`,
			`DATABASE_URL=${databaseUrls[0]}`,
			`DATABASE_URL=\"${databaseUrls[1]}\"`,
			`{\"DATABASE_URL\": \"${databaseUrls[2]}\"}`,
		].join("\n");
		const definition = workflow();
		const task = await buildIndependentReviewTask({
			workflow: definition,
			step: definition.steps[0]!,
			check: { type: "agent", prompt: "Inspect {input}" },
			ctx: ctx(secretInput),
			checkId: "sanitized-review",
			observableResult: { state: "present", text: secretInput },
		});

		expect(task).not.toContain(npmToken);
		for (const databaseUrl of databaseUrls) expect(task).not.toContain(databaseUrl);
		for (const password of ["database-password", "quoted-password", "json-password"]) {
			expect(task).not.toContain(password);
		}
		expect(task.match(/\[REDACTED SECRET\]/g)?.length).toBeGreaterThanOrEqual(8);
	});

	it("bounds and sanitizes untrusted independent-review identity fields", async () => {
		const hostileIdentity = `${"hostile\u0000\nidentity".repeat(150_000)}IDENTITY_CANARY`;
		const definition = workflow();
		const task = await buildIndependentReviewTask({
			workflow: { ...definition, name: hostileIdentity },
			step: { ...definition.steps[0]!, id: hostileIdentity },
			check: { type: "agent", prompt: "Inspect artifacts" },
			ctx: ctx(),
			checkId: hostileIdentity,
		});

		expect(Buffer.byteLength(task, "utf8")).toBeLessThan(20_000);
		expect(task).not.toContain("\u0000");
		expect(task).not.toContain("IDENTITY_CANARY");
		expect(task).toMatch(/check_id `sha256:[a-f0-9]{64}`/u);
	});

	it("propagates verdict transport errors before a wait is canceled", async () => {
		class FailingVerdictHost extends GateHost {
			override async awaitVerdict(): Promise<Verdict> {
				throw new Error("verdict transport failed");
			}
		}
		const definition = workflow();

		await expect(executeAgentCheck({
			host: new FailingVerdictHost(),
			workflow: definition,
			step: definition.steps[0]!,
			check: { type: "agent", prompt: "criteria" },
			ctx: ctx(),
			checkId: "transport-error",
		})).rejects.toThrow("verdict transport failed");
	});

	it("combines active cancellation signals and preserves an already-aborted signal", async () => {
		class SignalHost extends GateHost {
			receivedSignals: AbortSignal[] = [];
			override async awaitVerdict(_checkId: string, _timeoutMs?: number, signal?: AbortSignal): Promise<Verdict> {
				this.receivedSignals.push(signal!);
				return { checkId: "ignored", pass: true, reason: "signal observed" };
			}
		}
		const host = new SignalHost();
		const active = new AbortController();
		const aborted = new AbortController();
		aborted.abort();
		const definition = workflow();
		const check: AgentCheck = { type: "agent", prompt: "criteria" };

		await executeAgentCheck({
			host,
			workflow: definition,
			step: definition.steps[0]!,
			check,
			ctx: ctx(),
			checkId: "active-signal",
			signal: active.signal,
		});
		await executeAgentCheck({
			host,
			workflow: definition,
			step: definition.steps[0]!,
			check,
			ctx: ctx(),
			checkId: "aborted-signal",
			signal: aborted.signal,
		});

		expect(host.receivedSignals[0]).not.toBe(active.signal);
		expect(host.receivedSignals[0]?.aborted).toBe(false);
		expect(host.receivedSignals[1]).toBe(aborted.signal);
	});

	it("returns the reported verdict", async () => {
		const host = new GateHost();
		host.verdict = { checkId: "ignored", pass: true, reason: "looks good" };

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria" },
			ctx: ctx(),
			checkId: "check",
		});

		expect(result.pass).toBe(true);
		expect(result.reason).toBe("looks good");
		expect(host.instructions).toHaveLength(1);
	});

	it("re-prompts once and fails when no verdict is reported", async () => {
		const host = new GateHost();
		host.neverVerdict = true;

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria" },
			ctx: ctx(),
			checkId: "check",
		});

		expect(result.pass).toBe(false);
		expect(result.reason).toBe("no verdict reported");
		expect(host.instructions).toHaveLength(2);
		expect(host.instructions[1]).toContain("Call the `anvil_verdict` tool now");
	});

	it("cancels stale verdict waiters after giving up on an agent check", async () => {
		const bus = new VerdictBus();
		class BusHost extends GateHost {
			override awaitVerdict(checkId: string, timeoutMs = 0, signal?: AbortSignal): Promise<Verdict | undefined> {
				return bus.awaitVerdict(checkId, timeoutMs, signal);
			}
		}
		const host = new BusHost();

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", prompt: "criteria" },
			ctx: ctx(),
			checkId: "check",
			timeoutMs: 10_000,
		});

		expect(result).toMatchObject({ pass: false, reason: "no verdict reported" });
		const acceptedLateVerdict = bus.reportVerdict("check", true, "late rubber stamp");
		bus.clear();
		expect(acceptedLateVerdict).toBe(false);
	});

	it("re-prompts after a timed-out verdict wait and then accepts a verdict", async () => {
		const host = new GateHost();
		host.verdictQueue.push(undefined, { checkId: "ignored", pass: false, reason: "needs work" });

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", id: "quality", prompt: "criteria" },
			ctx: ctx(),
			checkId: "check",
		});

		expect(result).toMatchObject({ name: "quality", pass: false, reason: "needs work" });
		expect(host.instructions).toHaveLength(2);
	});

	it("starts a fresh verdict timeout when the first check turn completes without a verdict", async () => {
		const host = new TurnFirstRepromptHost();

		const result = await executeAgentCheck({
			host,
			workflow: workflow(),
			step: workflow().steps[0]!,
			check: { type: "agent", id: "quality", prompt: "criteria" },
			ctx: ctx(),
			checkId: "check",
			timeoutMs: 123,
		});

		expect(result).toMatchObject({ name: "quality", pass: true, reason: "fresh verdict after reprompt" });
		expect(host.verdictTimeouts).toEqual([123, 123]);
		expect(host.instructions).toHaveLength(2);
		expect(host.instructions[1]).toContain("Call the `anvil_verdict` tool now");
	});
});

function workflow(): WorkflowDefinition {
	return { name: "test", steps: [{ id: "one", prompt: "do it" }] };
}

function ctx(input = "task", loopCounts: Record<string, number> = {}, outputs: Record<string, string> = {}) {
	return { input, step: { id: "one", index: 0 }, loopCounts, cwd: "/tmp", outputs };
}
