import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runWorkflow,
	type AnvilCheckpoint,
	type EngineHost,
	type EngineExecResult,
	type RunSummary,
	type StepModelSelection,
	type SubagentStepRunRequest,
	type SubagentStepRunResult,
} from "../src/engine.ts";
import type { Verdict } from "../src/gates.ts";
import type { WorkflowDefinition } from "../src/types.ts";

const ORIGINAL_HERDR_ENV = process.env.HERDR_ENV;
const ORIGINAL_CMUX_SHELL_INTEGRATION = process.env.CMUX_SHELL_INTEGRATION;

beforeEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.CMUX_SHELL_INTEGRATION;
});

afterEach(() => {
	restoreEnv("HERDR_ENV", ORIGINAL_HERDR_ENV);
	restoreEnv("CMUX_SHELL_INTEGRATION", ORIGINAL_CMUX_SHELL_INTEGRATION);
});

class FakeHost implements EngineHost {
	instructions: string[] = [];
	checkpoints: AnvilCheckpoint[] = [];
	notifications: string[] = [];
	statuses: Array<string | undefined> = [];
	widgets: Array<string[] | undefined> = [];
	summaries: RunSummary[] = [];
	execQueue: EngineExecResult[] = [];
	modelSelections: Array<StepModelSelection | undefined> = [];
	activeModelSelection: StepModelSelection | undefined;
	verdictModelSelections: Array<StepModelSelection | undefined> = [];
	verdictTimeouts: number[] = [];
	verdictQueue: Array<Omit<Verdict, "checkId">> = [];
	modelSelectionError?: Error;
	onWait?: () => void | Promise<void>;
	subagentRequests: SubagentStepRunRequest[] = [];
	subagentQueue: SubagentStepRunResult[] = [];
	runSubagent?: (request: SubagentStepRunRequest, signal?: AbortSignal) => Promise<SubagentStepRunResult>;

	enableSubagents(): void {
		this.runSubagent = async (request) => {
			this.subagentRequests.push(request);
			return this.subagentQueue.shift() ?? { summary: "subagent done", sessionFile: "/tmp/child.jsonl", exitCode: 0 };
		};
	}

	async applyStepModelSelection(selection: StepModelSelection | undefined): Promise<void> {
		this.modelSelections.push(cloneSelection(selection));
		if (this.modelSelectionError) throw this.modelSelectionError;
		this.activeModelSelection = cloneSelection(selection);
	}

	sendInstruction(instruction: string): void {
		this.instructions.push(instruction);
	}

	async waitForTurnComplete(): Promise<void> {
		await this.onWait?.();
	}

	async exec(): Promise<EngineExecResult> {
		return this.execQueue.shift() ?? { stdout: "", stderr: "", code: 0 };
	}

	async awaitVerdict(checkId: string, timeoutMs: number): Promise<Verdict | undefined> {
		this.verdictModelSelections.push(cloneSelection(this.activeModelSelection));
		this.verdictTimeouts.push(timeoutMs);
		const verdict = this.verdictQueue.shift();
		return verdict ? { checkId, ...verdict } : undefined;
	}

	checkpoint(entry: AnvilCheckpoint): void {
		this.checkpoints.push(entry);
	}

	notify(message: string): void {
		this.notifications.push(message);
	}

	setStatus(text: string | undefined): void {
		this.statuses.push(text);
	}

	setWidget(lines: string[] | undefined): void {
		this.widgets.push(lines);
	}

	postSummary(summary: RunSummary): void {
		this.summaries.push(summary);
	}
}

describe("runWorkflow", () => {
	it("runs a linear workflow successfully", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({ workflow: workflow([{ id: "one", prompt: "1" }, { id: "two", prompt: "2" }]), input: "task", cwd: "/tmp", host, runId: "run" });

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(2);
		expect(host.checkpoints.map((entry) => entry.phase)).toEqual([
			"run_start",
			"step_start",
			"step_pass",
			"step_start",
			"step_pass",
			"run_end",
		]);
	});

	it("runs forEach function items with item prompt context", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item} ({itemIndex}/{itemCount})",
					forEach: { items: () => ["a.ts", "b.ts"] },
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(2);
		expect(host.instructions[0]).toContain("work a.ts (0/2)");
		expect(host.instructions[1]).toContain("work b.ts (1/2)");
		expect(host.checkpoints.filter((entry) => entry.phase === "step_start").map((entry) => entry.itemIndex)).toEqual([0, 1]);
	});

	it("enumerates forEach command items and passes empty lists", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "one\n\ntwo\n", stderr: "", code: 0 });
		const summary = await runWorkflow({
			workflow: workflow([{ id: "fanout", prompt: "work {item}", forEach: { items: { command: "printf items" } } }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions.map((instruction) => instruction.includes("work one") || instruction.includes("work two"))).toEqual([true, true]);
	});

	it("fails a forEach step when maxItems is exceeded", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "fanout", prompt: "work", forEach: { items: () => ["a", "b"], maxItems: 1 } }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("exceeding maxItems 1");
	});

	it("passes an empty forEach step with a notify and a 0-items checkpoint reason", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "fanout", prompt: "work {item}", forEach: { items: () => [] } }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(0);
		expect(host.notifications).toContain('forEach step "fanout" has 0 items');
		expect(host.checkpoints.find((entry) => entry.phase === "step_pass")?.reason).toBe("forEach: 0 items");
	});

	it("enumerates forEach command items parsed as JSON and rejects malformed JSON", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: '["x.ts", "y.ts"]', stderr: "", code: 0 });
		const ok = await runWorkflow({
			workflow: workflow([
				{ id: "fanout", prompt: "work {item}", forEach: { items: { command: "emit", parse: "json" } } },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});
		expect(ok.state).toBe("succeeded");
		expect(host.instructions.map((i) => i.includes("work x.ts") || i.includes("work y.ts"))).toEqual([true, true]);

		const badHost = new FakeHost();
		badHost.execQueue.push({ stdout: "not json", stderr: "", code: 0 });
		const bad = await runWorkflow({
			workflow: workflow([
				{ id: "fanout", prompt: "work {item}", forEach: { items: { command: "emit", parse: "json" } } },
			]),
			input: "task",
			cwd: "/tmp",
			host: badHost,
			runId: "run",
		});
		expect(bad.state).toBe("failed");
		expect(bad.failureReason).toContain("did not output valid JSON");
	});

	it("fails a forEach step when the item command exits non-zero", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "boom", code: 2 });
		const summary = await runWorkflow({
			workflow: workflow([{ id: "fanout", prompt: "work {item}", forEach: { items: { command: "emit" } } }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain('forEach item command for step "fanout" exited 2');
	});

	it("fails a forEach step when a function source returns non-string items", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "fanout", prompt: "work", forEach: { items: () => [1, 2] as unknown as string[] } }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("must be an array of strings");
	});

	it("retries only the failing item with its own feedback and keeps loop counts per item", async () => {
		const host = new FakeHost();
		// item a: check fails then passes on retry; item b: passes first try.
		host.execQueue.push(
			{ stdout: "", stderr: "a is broken", code: 1 },
			{ stdout: "ok", stderr: "", code: 0 },
			{ stdout: "ok", stderr: "", code: 0 },
		);
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
					delegation: "none",
					forEach: { items: () => ["a", "b"] },
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "fanout", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(3);
		expect(host.instructions[0]).toContain("work a");
		expect(host.instructions[0]).not.toContain("Feedback");
		expect(host.instructions[1]).toContain("work a");
		expect(host.instructions[1]).toContain("a is broken");
		expect(host.instructions[2]).toContain("work b");
		expect(host.instructions[2]).not.toContain("a is broken");
		expect(summary.loopCounts["tests->fanout#0"]).toBe(1);
		expect(summary.loopCounts["tests->fanout#1"]).toBeUndefined();
		expect(
			host.checkpoints.filter((e) => e.phase === "check_result").map((e) => e.itemIndex),
		).toEqual([0, 0, 1]);
	});

	it("continues past an exhausted item and captures a per-item digest when onItemExhausted is continue", async () => {
		const host = new FakeHost();
		// item a exhausts immediately (maxLoops 0), item b passes.
		host.execQueue.push({ stdout: "", stderr: "a bad", code: 1 }, { stdout: "ok", stderr: "", code: 0 });
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
					delegation: "none",
					forEach: { items: () => ["a", "b"], onItemExhausted: "continue" },
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "fanout", maxLoops: 0 } }],
				},
				{ id: "report", prompt: "digest: {outputs.fanout}", delegation: "none" },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		const reportInstruction = host.instructions.at(-1) ?? "";
		expect(reportInstruction).toContain("[1/2] a — FAILED");
		expect(reportInstruction).toContain("[2/2] b — ok");
	});

	it("fails a forEach step when every item fails under onItemExhausted continue", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "a bad", code: 1 }, { stdout: "", stderr: "b bad", code: 1 });
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
					delegation: "none",
					forEach: { items: () => ["a", "b"], onItemExhausted: "continue" },
					checks: [{ type: "deterministic", command: "test", onFail: { goto: "fanout", maxLoops: 0 } }],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain('item 1/2 "a" failed');
	});

	it("runs forEach items in fresh subagent sessions and escalates the model per item", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		// item a: check fails then passes; item b: passes first try.
		host.execQueue.push(
			{ stdout: "", stderr: "retry a", code: 1 },
			{ stdout: "ok", stderr: "", code: 0 },
			{ stdout: "ok", stderr: "", code: 0 },
		);
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
					delegation: { subagent: "cmux" },
					model: "cheap/model:minimal",
					retryModelSelections: [{ retry: 1, model: "strong/model", thinkingLevel: "high" }],
					forEach: { items: () => ["a", "b"] },
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "fanout", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }))).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "strong/model", thinkingLevel: "high" },
			{ model: "cheap/model", thinkingLevel: "minimal" },
		]);
	});

	it("re-runs the whole forEach step on resume without applying the resume retry seed to items", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
					delegation: { subagent: "herdr" },
					model: "cheap/model:low",
					retryModelSelections: [{ retry: 2, model: "strong/model:high" }],
					forEach: { items: () => ["a"] },
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
			resume: { stepNumber: 1, retryCount: 2 },
		});

		expect(summary.state).toBe("succeeded");
		// The resume seed would pick strong/model at retry 2; items start fresh, so it stays cheap.
		expect(host.subagentRequests[0]).toMatchObject({ model: "cheap/model", thinkingLevel: "low" });
	});

	it("applies per-step model selections and restores the default for unspecified steps", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "one", prompt: "1", model: "openai-codex/gpt-5.5:high" },
				{ id: "two", prompt: "2" },
				{ id: "three", prompt: "3", model: "openai-codex/gpt-5.5", thinkingLevel: "xhigh" },
				{ id: "four", prompt: "4", thinkingLevel: "low" },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.modelSelections).toEqual([
			{ model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
			undefined,
			{ model: "openai-codex/gpt-5.5", thinkingLevel: "xhigh" },
			{ thinkingLevel: "low" },
			undefined,
		]);
	});

	it("does not touch model selection when the workflow declares no model or thinking overrides", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "one", prompt: "1" },
				{ id: "two", prompt: "2" },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(2);
		expect(host.modelSelections).toEqual([]);
	});

	it("does not restore model selection after a failed run with no model or thinking overrides", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "boom", code: 1 });

		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", checks: [{ type: "deterministic", command: "false" }] }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("boom");
		expect(host.modelSelections).toEqual([]);
	});

	it("does not apply model selection for skipped steps", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "skip", prompt: "skip", model: "openai-codex/gpt-5.5:high", skipIf: () => true },
				{ id: "run", prompt: "run" },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(1);
		expect(host.modelSelections).toEqual([undefined, undefined]);
	});

	it("fails before sending a step when model selection fails", async () => {
		const host = new FakeHost();
		host.modelSelectionError = new Error('model "missing-model" was not found');
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", model: "missing-model:high" }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.steps[0]?.status).toBe("failed");
		expect(summary.failureReason).toContain('model "missing-model" was not found');
		expect(host.instructions).toHaveLength(0);
	});

	it("stops on a failed deterministic check by default", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "nope", code: 1 });
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", checks: [{ type: "deterministic", command: "false" }] }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.steps[0]?.status).toBe("failed");
		expect(summary.failureReason).toContain("nope");
	});

	it("loops with feedback on goto and then passes", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "missing file", code: 1 }, { stdout: "ok", stderr: "", code: 0 });
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}",
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(2);
		expect(host.instructions[1]).toContain("## Feedback from failed check");
		expect(host.instructions[1]).toContain("missing file");
		expect(summary.loopCounts["tests->implement"]).toBe(1);
	});

	it("fails when a goto loop budget is exhausted", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "bad", code: 1 });
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "one", prompt: "1", checks: [{ type: "deterministic", command: "false", onFail: { goto: "one", maxLoops: 0 } }] },
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("loop budget exhausted");
	});

	it("continues when an exhausted goto policy says to continue", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "bad", code: 1 });
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "one",
					prompt: "1",
					checks: [{ type: "deterministic", command: "false", onFail: { goto: "one", maxLoops: 0, onExhausted: "continue" } }],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(summary.steps[0]?.status).toBe("continued");
	});

	it("continues immediately for onFail continue", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "bad", code: 1 });
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", checks: [{ type: "deterministic", command: "false", onFail: "continue" }] }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(summary.steps[0]?.status).toBe("continued");
	});

	it("skips steps with skipIf", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "skip", prompt: "skip", skipIf: () => true }, { id: "run", prompt: "run" }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(summary.steps[0]?.status).toBe("skipped");
		expect(host.instructions).toHaveLength(1);
	});

	it("uses workflow-level skill delegation without naming a delegation tool", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: { skill: "implementer" } } },
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions[0]).toContain('using skill "implementer"');
		expect(host.instructions[0]).not.toContain("anvil_verdict");
		expect(host.instructions[0]).not.toContain("subagent tool");
	});

	it("allows steps to opt out of workflow-level delegation", async () => {
		const host = new FakeHost();
		await runWorkflow({
			workflow: {
				...workflow([{ id: "one", prompt: "Do {input}", delegation: "none" }]),
				defaults: { delegation: { skill: "implementer" } },
			},
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(host.instructions[0]).toContain("Do not delegate to a subagent");
	});

	it("uses legacy agent fields as auto-delegation hints", async () => {
		const host = new FakeHost();
		await runWorkflow({
			workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { agent: "implementer" } },
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(host.instructions[0]).toContain('Prefer agent/skill "implementer"');
	});

	it("captures a subagent summary for later step templates", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.subagentQueue.push({ summary: "PLAN: edit src/engine.ts", sessionFile: "/tmp/child.jsonl", exitCode: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}", delegation: { subagent: "cmux" } },
				{ id: "implement", prompt: "Implement from prior output: {outputs.plan}", delegation: "none" },
			]),
			input: "feature",
			cwd: "/repo",
			host,
			runId: "run-step-output-subagent",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions[0]).toContain("Implement from prior output: PLAN: edit src/engine.ts");
	});

	it("captures deterministic check stdout when outputFrom references that check", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "artifact=dist/app.js\n", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "build",
					prompt: "Build {input}",
					checks: [{ type: "deterministic", id: "artifact", command: "npm run build" }],
					outputFrom: "artifact",
				} as any,
				{ id: "verify", prompt: "Verify {outputs.build}", delegation: "none" },
			]),
			input: "feature",
			cwd: "/repo",
			host,
			runId: "run-step-output-check",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions[1]).toContain("Verify artifact=dist/app.js");
	});

	it("overwrites a step output when retry loops rerun the producing step", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.subagentQueue.push(
			{ summary: "first plan", sessionFile: "/tmp/one.jsonl", exitCode: 0 },
			{ summary: "revised plan", sessionFile: "/tmp/two.jsonl", exitCode: 0 },
		);
		host.execQueue.push({ stdout: "", stderr: "fail", code: 1 }, { stdout: "", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}", delegation: { subagent: "cmux" } },
				{
					id: "verify-plan",
					prompt: "Verify plan",
					checks: [{ type: "deterministic", id: "check", command: "test", onFail: { goto: "plan", maxLoops: 1 } }],
				},
				{ id: "implement", prompt: "Use {outputs.plan}", delegation: "none" },
			]),
			input: "feature",
			cwd: "/repo",
			host,
			runId: "run-step-output-retry",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions.at(-1)).toContain("Use revised plan");
		expect(host.instructions.at(-1)).not.toContain("first plan");
	});

	it("runs subagent-delegated steps through host.runSubagent instead of the main session", async () => {
		for (const backend of ["cmux", "herdr"] as const) {
			const host = new FakeHost();
			host.enableSubagents();
			const summary = await runWorkflow({
				workflow: {
					...workflow([{ id: "one", title: "Implement", prompt: "Do {input}", model: "openai-codex/gpt-5.5:high" }]),
					defaults: { delegation: { subagent: backend } },
				},
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(0);
			expect(host.modelSelections).toHaveLength(0);
			expect(host.subagentRequests).toHaveLength(1);
			const request = host.subagentRequests[0]!;
			expect(request.backend).toBe(backend);
			expect(request.cwd).toBe("/repo");
			expect(request.stepTitle).toBe("Implement");
			expect(request.model).toBe("openai-codex/gpt-5.5");
			expect(request.thinkingLevel).toBe("high");
			expect(request.task).toContain("Do task");
			expect(request.task).toContain("subagent session executing this workflow step");
		}
	});

	it("selects the subagent step model before evaluating its agent checks", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.verdictQueue.push({ pass: true, reason: "subagent work looks good" });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}", delegation: "none", model: "cheap/model:minimal" },
				{
					id: "implement",
					prompt: "Implement {input}",
					delegation: { subagent: "cmux" },
					model: "grader/model:high",
					checks: [{ type: "agent", id: "review", prompt: "Review the subagent output" }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-subagent-agent-check-model",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests).toHaveLength(1);
		expect(host.verdictModelSelections).toEqual([{ model: "grader/model", thinkingLevel: "high" }]);
		expect(host.modelSelections).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "grader/model", thinkingLevel: "high" },
			undefined,
		]);
	});

	it("resets to the workflow default before agent checks on subagent steps without a model", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.verdictQueue.push({ pass: true, reason: "default grader passed" });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}", delegation: "none", model: "cheap/model:minimal" },
				{
					id: "implement",
					prompt: "Implement {input}",
					delegation: { subagent: "cmux" },
					checks: [{ type: "agent", id: "review", prompt: "Review under the workflow default" }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-subagent-agent-check-default-model",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.verdictModelSelections).toEqual([undefined]);
		expect(host.modelSelections).toEqual([{ model: "cheap/model", thinkingLevel: "minimal" }, undefined, undefined]);
	});

	it("fails before grading subagent agent checks when their model selection cannot be applied", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.modelSelectionError = new Error('model "missing/grader" was not found');

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}",
					delegation: { subagent: "cmux" },
					model: "missing/grader:high",
					checks: [{ type: "agent", id: "review", prompt: "Review the subagent output" }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-subagent-agent-check-model-error",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain('model "missing/grader" was not found');
		expect(host.subagentRequests).toHaveLength(1);
		expect(host.verdictModelSelections).toEqual([]);
		expect(host.instructions).toHaveLength(0);
	});

	it("auto-detects HERDR_ENV=1 as herdr subagent delegation", async () => {
		await withSubagentEnv({ HERDR_ENV: "1" }, async () => {
			const host = new FakeHost();
			host.enableSubagents();
			const summary = await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(0);
			expect(host.subagentRequests).toHaveLength(1);
			expect(host.subagentRequests[0]?.backend).toBe("herdr");
		});
	});

	it("auto-detects CMUX_SHELL_INTEGRATION=1 as cmux subagent delegation", async () => {
		await withSubagentEnv({ CMUX_SHELL_INTEGRATION: "1" }, async () => {
			const host = new FakeHost();
			host.enableSubagents();
			const summary = await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(0);
			expect(host.subagentRequests).toHaveLength(1);
			expect(host.subagentRequests[0]?.backend).toBe("cmux");
		});
	});

	it("prefers herdr when both auto-detection environment variables are present", async () => {
		await withSubagentEnv({ HERDR_ENV: "1", CMUX_SHELL_INTEGRATION: "1" }, async () => {
			const host = new FakeHost();
			host.enableSubagents();
			await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(host.subagentRequests[0]?.backend).toBe("herdr");
		});
	});

	it("uses auto-detected subagents by default when no delegation is configured", async () => {
		await withSubagentEnv({ CMUX_SHELL_INTEGRATION: "1" }, async () => {
			const host = new FakeHost();
			host.enableSubagents();
			const summary = await runWorkflow({
				workflow: workflow([{ id: "one", prompt: "Do {input}" }]),
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(0);
			expect(host.subagentRequests[0]?.backend).toBe("cmux");
		});
	});

	it("runs auto steps in the main session when no subagent environment is detected", async () => {
		await withSubagentEnv({}, async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(1);
			expect(host.subagentRequests).toHaveLength(0);
		});
	});

	it("ignores non-1 shell integration values during auto detection", async () => {
		await withSubagentEnv({ HERDR_ENV: "0", CMUX_SHELL_INTEGRATION: "true" }, async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(1);
			expect(host.subagentRequests).toHaveLength(0);
		});
	});

	it("honors explicit non-auto delegation over detected subagent environments", async () => {
		await withSubagentEnv({ HERDR_ENV: "1", CMUX_SHELL_INTEGRATION: "1" }, async () => {
			const noneHost = new FakeHost();
			await runWorkflow({
				workflow: workflow([{ id: "main", prompt: "Do {input}", delegation: "none" }]),
				input: "task",
				cwd: "/repo",
				host: noneHost,
				runId: "run-none",
			});
			expect(noneHost.instructions).toHaveLength(1);
			expect(noneHost.subagentRequests).toHaveLength(0);

			const cmuxHost = new FakeHost();
			cmuxHost.enableSubagents();
			await runWorkflow({
				workflow: workflow([{ id: "cmux", prompt: "Do {input}", delegation: { subagent: "cmux" } }]),
				input: "task",
				cwd: "/repo",
				host: cmuxHost,
				runId: "run-cmux",
			});
			expect(cmuxHost.subagentRequests[0]?.backend).toBe("cmux");
		});
	});

	it("fails when auto-detected subagent delegation is unavailable on the host", async () => {
		await withSubagentEnv({ HERDR_ENV: "1" }, async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: { ...workflow([{ id: "one", prompt: "Do {input}" }]), defaults: { delegation: "auto" } },
				input: "task",
				cwd: "/repo",
				host,
				runId: "run",
			});

			expect(summary.state).toBe("failed");
			expect(summary.failureReason).toContain("herdr");
			expect(summary.failureReason).toContain("cannot run subagents");
			expect(host.instructions).toHaveLength(0);
		});
	});

	it("lets steps override subagent delegation back to the main agent", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		await runWorkflow({
			workflow: {
				...workflow([{ id: "one", prompt: "Do {input}", runInMain: true }]),
				defaults: { delegation: { subagent: "cmux" } },
			},
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
		});

		expect(host.subagentRequests).toHaveLength(0);
		expect(host.instructions).toHaveLength(1);
	});

	it("fails when subagent delegation is declared but the host cannot run subagents", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", delegation: { subagent: "cmux" } }]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.steps[0]?.status).toBe("failed");
		expect(summary.failureReason).toContain("cannot run subagents");
		expect(host.instructions).toHaveLength(0);
	});

	it("fails the run when the subagent reports an error", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.subagentQueue.push({ summary: "boom", exitCode: 1, errorMessage: "provider overloaded" });
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", delegation: { subagent: "cmux" } }]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toBe("provider overloaded");
	});

	it("loops subagent steps with feedback from failed checks", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.execQueue.push({ stdout: "", stderr: "missing file", code: 1 }, { stdout: "ok", stderr: "", code: 0 });
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}",
					delegation: { subagent: "cmux" },
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests).toHaveLength(2);
		expect(host.subagentRequests[1]?.task).toContain("## Feedback from failed check");
		expect(host.subagentRequests[1]?.task).toContain("missing file");
	});

	it("uses static subagent model and thinking on every retry when no retry selections are configured", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.execQueue.push({ stdout: "", stderr: "missing file", code: 1 }, { stdout: "ok", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}",
					delegation: { subagent: "cmux" },
					model: "cheap/model:minimal",
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-static-subagent-model-retry",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }))).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "cheap/model", thinkingLevel: "minimal" },
		]);
	});

	it("switches subagent model and thinking from the highest retry threshold less than or equal to the retry count", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		host.execQueue.push(
			{ stdout: "", stderr: "retry 1", code: 1 },
			{ stdout: "", stderr: "retry 2", code: 1 },
			{ stdout: "", stderr: "retry 3", code: 1 },
			{ stdout: "ok", stderr: "", code: 0 },
		);

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					delegation: { subagent: "cmux" },
					model: "cheap/model:minimal",
					retryModelSelections: [
						{ retry: 1, model: "strong/model", thinkingLevel: "high" },
						{ retry: 3, model: "strongest/model:xhigh" },
					],
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 3 } }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-retry-subagent-models",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests.map(({ model, thinkingLevel }) => ({ model, thinkingLevel }))).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "strong/model", thinkingLevel: "high" },
			{ model: "strong/model", thinkingLevel: "high" },
			{ model: "strongest/model", thinkingLevel: "xhigh" },
		]);
	});

	it("uses resume-seeded retry count when choosing subagent retry model selection", async () => {
		const host = new FakeHost();
		host.enableSubagents();

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					delegation: { subagent: "herdr" },
					model: "cheap/model:low",
					retryModelSelections: [{ retry: 2, model: "strong/model:high" }],
				},
			]),
			input: "resume feature",
			cwd: "/repo",
			host,
			runId: "run-resume-subagent-retry-model",
			resume: { stepNumber: 1, retryCount: 2 },
		});

		expect(summary.state).toBe("succeeded");
		expect(host.subagentRequests).toHaveLength(1);
		expect(host.subagentRequests[0]).toMatchObject({ model: "strong/model", thinkingLevel: "high" });
		expect(host.subagentRequests[0]?.task).toContain("retry 2");
	});

	it("applies retry model selections to main-session retries as well as subagent launches", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "missing file", code: 1 }, { stdout: "ok", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					delegation: "none",
					model: "cheap/model:minimal",
					retryModelSelections: [{ retry: 1, model: "strong/model", thinkingLevel: "high" }],
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 1 } }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-main-session-retry-models",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.modelSelections).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "strong/model", thinkingLevel: "high" },
			undefined,
		]);
	});

	it("returns an aborted summary when aborted mid-step", async () => {
		const host = new FakeHost();
		const controller = new AbortController();
		host.onWait = () => {
			controller.abort();
			throw new Error("aborted by test");
		};

		const summary = await runWorkflow({ workflow: workflow([{ id: "one", prompt: "1" }]), input: "task", cwd: "/tmp", host, runId: "run", signal: controller.signal });

		expect(summary.state).toBe("aborted");
		expect(host.checkpoints.at(-1)?.phase).toBe("run_end");
		expect(host.checkpoints.at(-1)?.finalState).toBe("aborted");
	});

	it("restores the workflow-start model when a run is aborted mid-step", async () => {
		const host = new FakeHost();
		const controller = new AbortController();
		host.onWait = () => {
			controller.abort();
			throw new Error("Anvil run aborted");
		};

		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1", model: "openai-codex/gpt-5.5:high" }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
			signal: controller.signal,
		});

		expect(summary.state).toBe("aborted");
		expect(host.modelSelections).toEqual([{ model: "openai-codex/gpt-5.5", thinkingLevel: "high" }, undefined]);
	});

	it("does not classify non-user upstream abort messages as user aborts", async () => {
		const host = new FakeHost();
		host.onWait = () => {
			throw new Error("request aborted by upstream provider");
		};

		const summary = await runWorkflow({ workflow: workflow([{ id: "one", prompt: "1" }]), input: "task", cwd: "/tmp", host, runId: "run" });

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toBe("request aborted by upstream provider");
	});

	it("leaves outputs from skipped resume steps empty", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}" },
				{ id: "implement", prompt: "Implement from [{outputs.plan}]" },
			]),
			input: "resume feature",
			cwd: "/tmp",
			host,
			runId: "run-resume-step-outputs",
			resume: { stepNumber: 2 },
		} as Parameters<typeof runWorkflow>[0] & { resume: { stepNumber: number } });

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(1);
		expect(host.instructions[0]).toContain("Implement from []");
	});

	it("resumes from a one-based step number without rerunning earlier steps", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", title: "Plan", prompt: "Plan {input}" },
				{ id: "implement", title: "Implement", prompt: "Implement {input}" },
				{ id: "verify", title: "Verify", prompt: "Verify {input}" },
			]),
			input: "resume feature",
			cwd: "/tmp",
			host,
			runId: "run-resume",
			resume: { stepNumber: 2 },
		} as Parameters<typeof runWorkflow>[0] & { resume: { stepNumber: number } });

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(2);
		expect(host.instructions[0]).toContain("step 2/3: Implement");
		expect(host.instructions[0]).toContain("Implement resume feature");
		expect(host.instructions[1]).toContain("step 3/3: Verify");
		expect(host.checkpoints.filter((entry) => entry.phase === "step_start").map((entry) => entry.stepIndex)).toEqual([1, 2]);
		expect(summary.steps.map((step) => step.status)).toEqual(["skipped", "passed", "passed"]);
	});

	it("seeds the resumed step loop count from the optional retry number", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "implement", prompt: "Implement {input}; retry {loop}" }]),
			input: "resume feature",
			cwd: "/tmp",
			host,
			runId: "run-resume-retry",
			resume: { stepNumber: 1, retryCount: 3 },
		} as Parameters<typeof runWorkflow>[0] & { resume: { stepNumber: number; retryCount: number } });

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(1);
		expect(host.instructions[0]).toContain("Implement resume feature; retry 3");
		expect(Math.max(0, ...Object.values(summary.loopCounts))).toBe(3);
	});

	it("increments retry loops from the resumed retry number on later check failures", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "still failing", code: 1 }, { stdout: "", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					checks: [{ type: "deterministic", command: "test", onFail: { goto: "implement", maxLoops: 4 } }],
				},
			]),
			input: "resume feature",
			cwd: "/tmp",
			host,
			runId: "run-resume-retry-failure",
			resume: { stepNumber: 1, retryCount: 3 },
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions[0]).toContain("retry 3");
		expect(host.instructions[1]).toContain("retry 4");
		expect(summary.loopCounts["implement:check1->implement"]).toBe(4);
	});

	it("rejects invalid resume step numbers before sending instructions", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "one", prompt: "1" }]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run-bad-resume",
			resume: { stepNumber: 0 },
		} as Parameters<typeof runWorkflow>[0] & { resume: { stepNumber: number } });

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toMatch(/resume step.*1/i);
		expect(host.instructions).toHaveLength(0);
		expect(host.checkpoints.filter((entry) => entry.phase === "step_start")).toHaveLength(0);
	});

	it("resumes subagent-delegated steps with the original workflow step index", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}" },
				{ id: "implement", title: "Implement", prompt: "Implement {input}", delegation: { subagent: "cmux" } },
			]),
			input: "resume feature",
			cwd: "/repo",
			host,
			runId: "run-resume-subagent",
			resume: { stepNumber: 2 },
		} as Parameters<typeof runWorkflow>[0] & { resume: { stepNumber: number } });

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toHaveLength(0);
		expect(host.subagentRequests).toHaveLength(1);
		expect(host.subagentRequests[0]).toMatchObject({ stepId: "implement", stepIndex: 1, stepCount: 2 });
		expect(host.subagentRequests[0]?.task).toContain("step 2/2: Implement");
	});

	it("threads agent check timeout settings from the workflow contract", async () => {
		const host = new FakeHost();
		host.verdictQueue.push({ pass: true, reason: "ok" });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "review",
					prompt: "Review",
					checks: [{ type: "agent", prompt: "criteria", timeoutMs: 1234 } as any],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run-agent-timeout",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.verdictTimeouts).toEqual([1234]);
	});

	it("shows only the latest check attempt in step summaries after a goto retry", async () => {
		const host = new FakeHost();
		host.execQueue.push(
			{ stdout: "", stderr: "first attempt failed", code: 1 },
			{ stdout: "", stderr: "", code: 0 },
			{ stdout: "", stderr: "", code: 0 },
		);

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					checks: [
						{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "implement", maxLoops: 1 } },
						{ type: "deterministic", id: "lint", command: "lint" },
					],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run-reset-check-history",
		});

		expect(summary.state).toBe("succeeded");
		expect(summary.steps[0]?.checks).toHaveLength(2);
		expect(summary.steps[0]?.checks.map((check) => [check.name, check.pass])).toEqual([
			["tests", true],
			["lint", true],
		]);
	});
});

function workflow(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
	return { name: "test-workflow", steps };
}

function cloneSelection(selection: StepModelSelection | undefined): StepModelSelection | undefined {
	return selection ? { ...selection } : undefined;
}

type AutoSubagentEnv = Partial<Record<"HERDR_ENV" | "CMUX_SHELL_INTEGRATION", string>>;

async function withSubagentEnv<T>(env: AutoSubagentEnv, fn: () => Promise<T>): Promise<T> {
	const previous: AutoSubagentEnv = {
		HERDR_ENV: process.env.HERDR_ENV,
		CMUX_SHELL_INTEGRATION: process.env.CMUX_SHELL_INTEGRATION,
	};
	delete process.env.HERDR_ENV;
	delete process.env.CMUX_SHELL_INTEGRATION;
	if (env.HERDR_ENV !== undefined) process.env.HERDR_ENV = env.HERDR_ENV;
	if (env.CMUX_SHELL_INTEGRATION !== undefined) process.env.CMUX_SHELL_INTEGRATION = env.CMUX_SHELL_INTEGRATION;

	try {
		return await fn();
	} finally {
		restoreEnv("HERDR_ENV", previous.HERDR_ENV);
		restoreEnv("CMUX_SHELL_INTEGRATION", previous.CMUX_SHELL_INTEGRATION);
	}
}

function restoreEnv(name: keyof AutoSubagentEnv, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
