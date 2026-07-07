import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { EngineHost, EngineExecOptions, EngineExecResult, RunSummary, AnvilCheckpoint } from "../src/engine.ts";
import { executeAgentCheck, executeDeterministicCheck, VerdictBus, type Verdict } from "../src/gates.ts";
import { renderTemplateString } from "../src/prompts.ts";
import type { WorkflowDefinition } from "../src/types.ts";

const execFileAsync = promisify(execFile);

class GateHost implements EngineHost {
	instructions: string[] = [];
	execResult: EngineExecResult = { stdout: "", stderr: "", code: 0 };
	execCalls: Array<{ command: string; args: string[]; options?: EngineExecOptions }> = [];
	verdict: Verdict | undefined;
	verdictQueue: Array<Verdict | undefined> = [];
	neverVerdict = false;
	turns = 0;

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

	async awaitVerdict(checkId: string): Promise<Verdict | undefined> {
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
});

describe("executeAgentCheck", () => {
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
});

function workflow(): WorkflowDefinition {
	return { name: "test", steps: [{ id: "one", prompt: "do it" }] };
}

function ctx(input = "task", loopCounts: Record<string, number> = {}) {
	return { input, step: { id: "one", index: 0 }, loopCounts, cwd: "/tmp" };
}
