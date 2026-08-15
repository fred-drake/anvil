import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	runWorkflow,
	type AnvilCheckpoint,
	type EngineHost,
	type EngineExecResult,
	type RunProgressSnapshot,
	type RunSummary,
	type StepModelSelection,
	type WorkspaceState,
} from "../src/engine.ts";
import { pinWorkflowSource, reloadPinnedWorkflow, loadWorkflowFile } from "../src/discovery.ts";
import type { Verdict } from "../src/gates.ts";
import { recoverResumeState, toAnvilCheckpoint } from "../src/history.ts";
import { MAX_STEP_OUTPUT_BYTES } from "../src/step-output.ts";
import type { WorkflowDefinition } from "../src/types.ts";

class FakeHost implements EngineHost {
	instructions: string[] = [];
	checkpoints: AnvilCheckpoint[] = [];
	notifications: string[] = [];
	statuses: Array<string | undefined> = [];
	widgets: Array<string[] | undefined> = [];
	summaries: RunSummary[] = [];
	execQueue: EngineExecResult[] = [];
	workspaceStates: Array<WorkspaceState | undefined> = [];
	modelSelections: Array<StepModelSelection | undefined> = [];
	progressSnapshots: RunProgressSnapshot[] = [];
	activeModelSelection: StepModelSelection | undefined;
	verdictModelSelections: Array<StepModelSelection | undefined> = [];
	verdictTimeouts: number[] = [];
	verdictQueue: Array<Omit<Verdict, "checkId">> = [];
	modelSelectionError?: Error;
	onWait?: () => void | Promise<void>;
	stepOutputQueue: Array<string | undefined> = [];
	capturedStepIds: string[] = [];

	async applyStepModelSelection(selection: StepModelSelection | undefined): Promise<void> {
		this.modelSelections.push(cloneSelection(selection));
		if (this.modelSelectionError) throw this.modelSelectionError;
		this.activeModelSelection = cloneSelection(selection);
	}

	beginStepOutputCapture(stepId: string): void {
		this.capturedStepIds.push(stepId);
	}

	endStepOutputCapture(stepId: string): string | undefined {
		expect(this.capturedStepIds.pop()).toBe(stepId);
		return this.stepOutputQueue.shift();
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

	async captureWorkspaceState(): Promise<WorkspaceState | undefined> {
		return this.workspaceStates.shift();
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

	setRunProgress(snapshot: RunProgressSnapshot): void {
		this.progressSnapshots.push(snapshot);
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

	it("passes subagent intent through the normal harness turn", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([{ id: "implement", prompt: "Use subagents to implement {input}." }]),
			input: "the change",
			cwd: "/tmp/project",
			host,
		});

		expect(summary.state).toBe("succeeded");
		expect(host.instructions).toEqual([
			expect.stringContaining("Task:\nUse subagents to implement the change."),
		]);
		expect(host.instructions[0]).not.toMatch(/Choose whether to use a subagent|Do not delegate|using skill|cmux|herdr/i);
	});

	it("fails an approval when the workspace changed after deterministic verification", async () => {
		const host = new FakeHost();
		const verified = { head: "abc", fingerprint: "verified", changedFiles: ["src/a.ts"], changedFileCount: 1 };
		const changed = { head: "abc", fingerprint: "changed", changedFiles: ["src/a.ts"], changedFileCount: 1 };
		host.workspaceStates.push(verified, verified, changed, changed);
		host.verdictQueue.push({ pass: true, reason: "approved" });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "verify",
					prompt: "verify",
					checks: [
						{ type: "deterministic", id: "tests", command: "npm test" },
						{ type: "agent", id: "approval", prompt: "approve" },
					],
				},
			]),
			input: "task",
			cwd: "/tmp",
			host,
			runId: "run",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toBe("workspace changed after the latest successful deterministic verification");
		expect(summary.evidence.lastVerification).toEqual(verified);
		expect(summary.steps[0]?.checks[1]).toMatchObject({ pass: false, type: "agent", workspaceState: changed });
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
					forEach: { items: () => ["a", "b"], onItemExhausted: "continue" },
					checks: [{ type: "deterministic", id: "tests", command: "test", onFail: { goto: "fanout", maxLoops: 0 } }],
				},
				{ id: "report", prompt: "digest: {outputs.fanout}" },
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

	it("runs forEach items through normal harness turns and escalates the model per item", async () => {
		const host = new FakeHost();
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
					prompt: "Use subagents to work {item}",
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
		expect(host.instructions).toHaveLength(3);
		expect(host.instructions[0]).toContain("Task:\nUse subagents to work a");
		expect(host.instructions[1]).toContain("retry a");
		expect(host.instructions[2]).toContain("Task:\nUse subagents to work b");
		expect(host.modelSelections).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "strong/model", thinkingLevel: "high" },
			{ model: "cheap/model", thinkingLevel: "minimal" },
			undefined,
		]);
	});

	it("re-runs the whole forEach step on resume without applying the resume retry seed to items", async () => {
		const host = new FakeHost();
		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "fanout",
					prompt: "work {item}",
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
		expect(host.modelSelections).toEqual([{ model: "cheap/model", thinkingLevel: "low" }, undefined]);
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

	it("keeps the step model selected while evaluating its agent checks", async () => {
		const host = new FakeHost();
		host.verdictQueue.push({ pass: true, reason: "work looks good" });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}", model: "cheap/model:minimal" },
				{
					id: "implement",
					prompt: "Implement {input}",
					model: "grader/model:high",
					checks: [{ type: "agent", id: "review", prompt: "Review the output" }],
				},
			]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-agent-check-model",
		});

		expect(summary.state).toBe("succeeded");
		expect(host.verdictModelSelections).toEqual([{ model: "grader/model", thinkingLevel: "high" }]);
		expect(host.modelSelections).toEqual([
			{ model: "cheap/model", thinkingLevel: "minimal" },
			{ model: "grader/model", thinkingLevel: "high" },
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
		expect(host.widgets.at(-1)).toEqual(["✖ Step failed: nope", "✖ one [0/1 checks]"]);
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
				{ id: "verify", prompt: "Verify {outputs.build}" },
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
		host.stepOutputQueue.push("first plan", undefined, "revised plan", undefined, undefined);
		host.execQueue.push({ stdout: "", stderr: "fail", code: 1 }, { stdout: "", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "plan", prompt: "Plan {input}" },
				{
					id: "verify-plan",
					prompt: "Verify plan",
					checks: [{ type: "deterministic", id: "check", command: "test", onFail: { goto: "plan", maxLoops: 1 } }],
				},
				{ id: "implement", prompt: "Use {outputs.plan}" },
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

	it("evaluates only the latest review output after a goto retry", async () => {
		const host = new FakeHost();
		host.stepOutputQueue.push(
			"implementation attempt one",
			"BLOCKING: stale defect",
			"implementation attempt two",
			"No blocking findings.",
		);
		host.verdictQueue.push(
			{ pass: false, reason: "stale defect needs remediation" },
			{ pass: true, reason: "latest review is clean" },
		);

		const summary = await runWorkflow({
			workflow: workflow([
				{ id: "implement", prompt: "Implement" },
				{
					id: "review",
					prompt: "Review",
					checks: [
						{
							type: "agent",
							id: "review-blockers",
							prompt: "Evaluate only this review:\n{outputs.review}",
							onFail: { goto: "implement", maxLoops: 1 },
						},
					],
				},
			]),
			input: "feature",
			cwd: "/repo",
			host,
			runId: "run-latest-review-output",
		});

		expect(summary.state).toBe("succeeded");
		const reviewInstructions = host.instructions.filter((instruction) => instruction.includes("Evaluation criteria:"));
		expect(reviewInstructions).toHaveLength(2);
		expect(reviewInstructions[0]).toContain("BLOCKING: stale defect");
		expect(reviewInstructions[1]).toContain("No blocking findings.");
		expect(reviewInstructions[1]).not.toContain("BLOCKING: stale defect");
	});

	it("uses resume-seeded retry count when choosing the main-session model selection", async () => {
		const host = new FakeHost();

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
					model: "cheap/model:low",
					retryModelSelections: [{ retry: 2, model: "strong/model:high" }],
				},
			]),
			input: "resume feature",
			cwd: "/repo",
			host,
			runId: "run-resume-main-retry-model",
			resume: { stepNumber: 1, retryCount: 2 },
		});

		expect(summary.state).toBe("succeeded");
		expect(host.modelSelections).toEqual([{ model: "strong/model", thinkingLevel: "high" }, undefined]);
		expect(host.instructions[0]).toContain("retry 2");
	});

	it("applies retry model selections to main-session retries", async () => {
		const host = new FakeHost();
		host.execQueue.push({ stdout: "", stderr: "missing file", code: 1 }, { stdout: "ok", stderr: "", code: 0 });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "implement",
					prompt: "Implement {input}; retry {loop}",
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

	describe("Feature 3 Phase 1 id-based resume", () => {
		it("executes inserted pre-target steps while reconciling surviving completed steps by id", async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: workflow([
					{ id: "new", prompt: "new" },
					{ id: "plan", prompt: "plan" },
					{ id: "implement", prompt: "implement" },
					{ id: "moved-complete", prompt: "moved" },
				]),
				input: "task", cwd: "/tmp", host,
				resume: { stepNumber: 3, completedStepIds: ["plan", "removed", "moved-complete"] },
			});

			expect(host.instructions.map((instruction) => instruction.match(/step \d+\/4: ([^\n]+)/)?.[1])).toEqual(["new", "implement", "moved-complete"]);
			expect(summary.steps.map(({ id, status }) => ({ id, status }))).toEqual([
				{ id: "new", status: "passed" },
				{ id: "plan", status: "skipped" },
				{ id: "implement", status: "passed" },
				{ id: "moved-complete", status: "passed" },
			]);
		});

		it("rehydrates bounded passed output only for surviving completed steps before the rerun target", async () => {
			const host = new FakeHost();
			await runWorkflow({
				workflow: workflow([
					{ id: "plan", prompt: "plan" },
					{ id: "missing", prompt: "missing" },
					{ id: "implement", prompt: "Use {outputs.plan}|{outputs.missing}" },
				]),
				input: "task", cwd: "/tmp", host,
				resume: { stepNumber: 3, completedStepIds: ["plan", "missing"], outputs: { plan: "latest plan" } },
			});

			expect(host.instructions[0]).toContain("Use latest plan|");
		});

		it("clears output for the rerun target and every later re-executed step", async () => {
			const host = new FakeHost();
			await runWorkflow({
				workflow: workflow([
					{ id: "plan", prompt: "plan" },
					{ id: "target", prompt: "stale={outputs.target}; later={outputs.later}; plan={outputs.plan}" },
					{ id: "later", prompt: "later" },
				]),
				input: "task", cwd: "/tmp", host,
				resume: {
					stepNumber: 2,
					completedStepIds: ["plan", "target", "later"],
					outputs: { plan: "fresh", target: "STALE_TARGET", later: "STALE_LATER" },
				},
			});

			expect(host.instructions[0]).toContain("stale=; later=; plan=fresh");
			expect(host.instructions[0]).not.toMatch(/STALE_TARGET|STALE_LATER/);
		});

		it("restores captured output from a step continued after a failed check", async () => {
			const firstHost = new FakeHost();
			firstHost.execQueue.push(
				{ stdout: "captured-before-continue\n", stderr: "", code: 0 },
				{ stdout: "", stderr: "product failure", code: 1 },
				{ stdout: "", stderr: "later failure", code: 1 },
			);
			const firstSummary = await runWorkflow({
				workflow: workflow([
					{
						id: "capture",
						prompt: "capture",
						outputFrom: "artifact",
						checks: [
							{ type: "deterministic", id: "artifact", command: "capture" },
							{ type: "deterministic", id: "continue", command: "fail", onFail: "continue" },
						],
					},
					{ id: "later", prompt: "later", checks: [{ type: "deterministic", command: "fail" }] },
				]),
				input: "task", cwd: "/tmp", host: firstHost, runId: "continued-run",
			});
			expect(firstSummary.steps[0]?.status).toBe("continued");
			const continuedPass = firstHost.checkpoints.find((checkpoint) => checkpoint.phase === "step_pass" && checkpoint.stepId === "capture");
			expect(continuedPass?.output).toContain("captured-before-continue");

			const entries = firstHost.checkpoints.map((data) => ({ type: "custom", customType: "anvil-run", data }));
			const recovery = recoverResumeState(entries, "continued-run", entries.length - 1);
			expect(recovery?.outputs.capture).toContain("captured-before-continue");

			const resumedHost = new FakeHost();
			await runWorkflow({
				workflow: workflow([
					{ id: "capture", prompt: "capture" },
					{ id: "later", prompt: "restored={outputs.capture}" },
				]),
				input: "task", cwd: "/tmp", host: resumedHost,
				resume: { stepNumber: 2, completedStepIds: recovery?.completedStepIds, outputs: recovery?.outputs },
			});
			expect(resumedHost.instructions).toHaveLength(1);
			expect(resumedHost.instructions[0]).toContain("restored=captured-before-continue");
		});

		it("persists a UTF-8-byte-bounded output snapshot only after terminal step_pass output settles", async () => {
			const host = new FakeHost();
			host.stepOutputQueue.push(`prefix-${"🙂".repeat(3_000)}`, undefined, "item result");
			host.execQueue.push({ stdout: "artifact-path\n", stderr: "", code: 0 });
			await runWorkflow({
				workflow: workflow([
					{ id: "main", prompt: "main" },
					{ id: "artifact", prompt: "artifact", outputFrom: "capture", checks: [{ type: "deterministic", id: "capture", command: "capture" }] },
					{ id: "fanout", prompt: "item {item}", forEach: { items: () => ["one"] } },
				]),
				input: "task", cwd: "/tmp", host,
			});

			const passed = Object.fromEntries(host.checkpoints.filter((checkpoint) => checkpoint.phase === "step_pass").map((checkpoint) => [checkpoint.stepId, checkpoint.output]));
			expect(Buffer.byteLength(passed.main, "utf8")).toBeLessThanOrEqual(MAX_STEP_OUTPUT_BYTES);
			expect(passed.main.startsWith("🙂")).toBe(true);
			expect(passed.artifact).toContain("artifact-path");
			expect(passed.fanout).toContain("item result");
		});

		it("keeps explicit current-definition positional resume and retry seeding unchanged", async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: workflow([{ id: "historical-target", prompt: "first" }, { id: "current-two", prompt: "loop {loop}" }]),
				input: "task", cwd: "/tmp", host,
				resume: { stepNumber: 2, retryCount: 3, completedStepIds: ["historical-target"] },
			});
			expect(host.instructions[0]).toContain("loop 3");
			expect(summary.steps.map((step) => step.status)).toEqual(["skipped", "passed"]);
		});

		it("preserves unedited-workflow resume state and numbered execution behavior", async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({
				workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }]),
				input: "task", cwd: "/tmp", host, resume: { stepNumber: 2 },
			});
			expect(host.instructions).toHaveLength(1);
			expect(summary.steps.map((step) => step.status)).toEqual(["skipped", "passed"]);
		});
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

	it("ends main-session output capture exactly once without consuming it when execution rejects", async () => {
		const host = new FakeHost();
		host.stepOutputQueue.push("MUST_REMAIN_UNCONSUMED");
		host.onWait = async () => {
			throw new Error("main execution rejected");
		};

		const summary = await runWorkflow({
			workflow: workflow([{ id: "implement", prompt: "Implement task" }]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-main-capture-rejection",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("main execution rejected");
		expect(host.capturedStepIds).toEqual([]);
		expect(JSON.stringify(summary)).not.toContain("MUST_REMAIN_UNCONSUMED");
	});

	it("ends forEach output capture exactly once without consuming it when execution rejects", async () => {
		const host = new FakeHost();
		host.stepOutputQueue.push("MUST_REMAIN_UNCONSUMED");
		host.onWait = async () => {
			throw new Error("forEach execution rejected");
		};

		const summary = await runWorkflow({
			workflow: workflow([{
				id: "fanout",
				prompt: "Implement {item}",
				forEach: { items: () => ["one.ts"] },
			}]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-foreach-capture-rejection",
		});

		expect(summary.state).toBe("failed");
		expect(summary.failureReason).toContain("forEach execution rejected");
		expect(host.capturedStepIds).toEqual([]);
		expect(JSON.stringify(summary)).not.toContain("MUST_REMAIN_UNCONSUMED");
	});

	it("routes prompt-requested fresh review subagents through the normal verdict gate", async () => {
		const host = new FakeHost();
		host.verdictQueue.push({ pass: true, reason: "fresh review passed" });

		const summary = await runWorkflow({
			workflow: workflow([{
				id: "implement",
				prompt: "Implement task",
				checks: [{ type: "agent", prompt: "Use a fresh review subagent to verify the implementation." }],
			}]),
			input: "task",
			cwd: "/repo",
			host,
			runId: "run-harness-managed-review",
		});

		expect(summary.state).toBe("succeeded");
		expect(summary.steps[0]?.checks[0]).toMatchObject({ pass: true, reason: "fresh review passed" });
		expect(host.instructions.at(-1)).toContain("Use a fresh review subagent");
	});

	it("threads agent check timeout settings from the workflow contract", async () => {
		const host = new FakeHost();
		host.verdictQueue.push({ pass: true, reason: "ok" });

		const summary = await runWorkflow({
			workflow: workflow([
				{
					id: "review",
					prompt: "Review",
					checks: [{ type: "agent", prompt: "criteria", timeoutMs: 1234 }],
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

	describe("watch reload (Phase 2)", () => {
		it("does not invoke the reload hook during ordinary deterministic runs", async () => {
			const host = new FakeHost();
			await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }]), input: "task", cwd: "/tmp", host });
			expect(host.instructions).toEqual([expect.stringContaining("one")]);
		});

		it("reloads only at outer step boundaries and applies a valid definition to the next step", async () => {
			const host = new FakeHost();
			let calls = 0;
			const changed = workflow([
				{ id: "one", prompt: "old one" },
				{ id: "two", prompt: "new two" },
			]);
			const summary = await runWorkflow({
				workflow: workflow([{ id: "one", prompt: "old one" }, { id: "two", prompt: "old two" }]),
				input: "task",
				cwd: "/tmp",
				host,
				reload: async () => ({ workflow: calls++ === 0 ? undefined : changed }),
			});
			expect(host.instructions).toEqual([expect.stringContaining("old one"), expect.stringContaining("new two")]);
			expect(summary.steps.map((step) => step.id)).toEqual(["one", "two"]);
		});

		it("never reloads while a step or an individual forEach item is executing", async () => {
			const host = new FakeHost();
			let reloads = 0;
			await runWorkflow({
				workflow: workflow([{ id: "fan", prompt: "item {item}", forEach: { items: () => ["a", "b"] } }]),
				input: "task",
				cwd: "/tmp",
				host,
				reload: async () => { reloads += 1; return {}; },
			});
			expect(reloads).toBe(1);
			expect(host.instructions).toHaveLength(2);
		});
		it("reconciles inserted, removed, and reordered steps by stable id while preserving completed state and outputs", async () => {
			const host = new FakeHost();
			host.stepOutputQueue.push("one-output", undefined, undefined);
			let calls = 0;
			const initial = workflow([{ id: "one", prompt: "one" }, { id: "removed", prompt: "removed" }, { id: "two", prompt: "old two" }]);
			const changed = workflow([{ id: "inserted", prompt: "insert {outputs.one}" }, { id: "two", prompt: "new two" }, { id: "one", prompt: "must not rerun" }]);
			const summary = await runWorkflow({ workflow: initial, input: "task", cwd: "/tmp", host, reload: async () => ({ workflow: calls++ === 0 ? undefined : changed }) });
			expect(host.instructions.join("\n")).toContain("insert one-output");
			expect(host.instructions.join("\n")).not.toContain("removed");
			expect(summary.steps.map((step) => [step.id, step.status])).toEqual([["inserted", "passed"], ["two", "passed"], ["one", "passed"]]);
		});

		it("runs newly inserted pending steps before the current target in deterministic order", async () => {
			const host = new FakeHost();
			let calls = 0;
			const changed = workflow([{ id: "new", prompt: "new" }, { id: "one", prompt: "one" }, { id: "two", prompt: "two" }]);
			await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }]), input: "task", cwd: "/tmp", host, reload: async () => ({ workflow: calls++ ? changed : undefined }) });
			expect(host.instructions.map((text) => text.match(/(?:one|new|two)/)?.[0])).toEqual(["one", "new", "two"]);
		});

		it("handles removal of the current or next target explicitly and deterministically", async () => {
			const host = new FakeHost();
			let calls = 0;
			const summary = await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }]), input: "task", cwd: "/tmp", host, reload: async () => ({ workflow: calls++ ? workflow([{ id: "one", prompt: "one" }]) : undefined }) });
			expect(summary.state).toBe("succeeded");
			expect(host.instructions).toHaveLength(1);
			expect(summary.steps.map((step) => step.id)).toEqual(["one"]);
		});

		it("retains the active definition and execution state when reload loading, parsing, schema, or goto validation fails", async () => {
			const host = new FakeHost();
			const summary = await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }]), input: "task", cwd: "/tmp", host, reload: async () => ({ warning: "candidate could not be loaded or validated" }) });
			expect(summary.state).toBe("succeeded");
			expect(summary.steps[0]?.status).toBe("passed");
			expect(host.notifications).toEqual([expect.stringMatching(/reload skipped.*validated/i)]);
		});

		it("publishes authoritative status metadata after a watch reload changes the workflow definition", async () => {
			const host = new FakeHost();
			let calls = 0;
			const changed: WorkflowDefinition = {
				name: "changed",
				steps: [
					{ id: "inserted", title: "Inserted", prompt: "inserted" },
					{ id: "one", title: "Renamed One", prompt: "one" },
					{ id: "two-new", title: "Changed Two", prompt: "two", model: "provider/model" },
				],
			};
			const summary = await runWorkflow({
				workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "old" }]),
				input: "task",
				cwd: "/tmp",
				host,
				reload: async () => ({ workflow: calls++ ? changed : undefined }),
			});
			const reloadedProgress = host.progressSnapshots.find((snapshot) => snapshot.workflowName === "changed" && snapshot.stepIndex === 2);

			expect(summary.workflowName).toBe("changed");
			expect(host.modelSelections).toContainEqual({ model: "provider/model" });
			expect(host.statuses.join(" ")).toContain("changed");
			expect(host.widgets.flat().join(" ")).toContain("Changed Two");
			expect(reloadedProgress).toEqual({
				workflowName: "changed",
				steps: [
					{ id: "inserted", title: "Inserted" },
					{ id: "one", title: "Renamed One" },
					{ id: "two-new", title: "Changed Two" },
				],
				stepIndex: 2,
				retryCount: 0,
			});
			expect(JSON.stringify(reloadedProgress)).not.toMatch(/\"two\"|\"old\"/);
		});

		it("preserves a forward goto target by stable id when a reload occurs before it executes", async () => {
			const host = new FakeHost();
			host.execQueue.push({ stdout: "", stderr: "b failed", code: 1 });
			let calls = 0;
			const initial = workflow([
				{ id: "a", prompt: "a" },
				{ id: "b", prompt: "b", checks: [{ type: "deterministic", command: "false", onFail: { goto: "d", maxLoops: 1 } }] },
				{ id: "c", prompt: "c" },
				{ id: "d", prompt: "d" },
			]);
			const changed = workflow([
				{ id: "a", prompt: "changed a" },
				{ id: "b", prompt: "changed b" },
				{ id: "c", prompt: "changed c" },
				{ id: "d", prompt: "changed d" },
			]);

			await runWorkflow({ workflow: initial, input: "task", cwd: "/tmp", host, reload: async () => ({ workflow: ++calls === 3 ? changed : undefined }) });

			expect(host.instructions[0]).toContain("a");
			expect(host.instructions[1]).toContain("b");
			expect(host.instructions[2]).toContain("changed d");
		});

		it("reruns every reset survivor in active definition order after a backward-goto reload reorder", async () => {
			const host = new FakeHost();
			host.execQueue.push(
				{ stdout: "", stderr: "c failed", code: 1 },
				{ stdout: "", stderr: "", code: 0 },
			);
			let reloads = 0;
			const retryingC = {
				id: "c",
				prompt: "execute c",
				checks: [{ type: "deterministic" as const, command: "test-c", onFail: { goto: "a", maxLoops: 1 } }],
			};
			const initial = workflow([
				{ id: "a", prompt: "execute a" },
				{ id: "b", prompt: "execute b" },
				{ id: "d", prompt: "execute d" },
				retryingC,
			]);
			const reordered = workflow([
				{ id: "d", prompt: "execute d" },
				{ id: "a", prompt: "execute a" },
				{ id: "b", prompt: "execute b" },
				retryingC,
			]);

			const summary = await runWorkflow({
				workflow: initial,
				input: "task",
				cwd: "/tmp",
				host,
				reload: async () => ({ workflow: ++reloads === 5 ? reordered : undefined }),
			});

			expect(summary.state).toBe("succeeded");
			expect(host.instructions.map((instruction) => instruction.match(/execute ([abdc])/)?.[1])).toEqual([
				"a", "b", "d", "c", "d", "a", "b", "c",
			]);
			expect(summary.steps.map((step) => [step.id, step.status])).toEqual([
				["d", "passed"],
				["a", "passed"],
				["b", "passed"],
				["c", "passed"],
			]);
			expect(summary.steps.every((step) => step.status !== "pending" && step.status !== "running")).toBe(true);
		});

		it("rejects a real dangling-goto candidate and keeps the original next step active", async () => {
			const root = await mkdtemp(join(tmpdir(), "anvil-watch-invalid-"));
			try {
				const dir = join(root, ".pi", "anvil", "workflows");
				const file = join(dir, "watched.ts");
				await mkdir(dir, { recursive: true });
				await writeFile(file, `export default { name: "watched", steps: [{ id: "one", prompt: "one" }, { id: "two", prompt: "original two" }] };`);
				const selected = await loadWorkflowFile(file, "project");
				const pinned = await pinWorkflowSource(selected);
				const host = new FakeHost();
				host.onWait = async () => {
					if (host.instructions.length === 1) await writeFile(file, `export default { name: "watched", steps: [{ id: "one", prompt: "changed" }, { id: "two", prompt: "unsafe", onFail: { goto: "missing" } }] };`);
				};
				const summary = await runWorkflow({ workflow: selected.workflow!, input: "task", cwd: root, host, reload: () => reloadPinnedWorkflow(pinned) });
				expect(summary.steps.map((step) => [step.id, step.status])).toEqual([["one", "passed"], ["two", "passed"]]);
				expect(host.instructions[1]).toContain("original two");
				expect(host.notifications).toContainEqual(expect.stringMatching(/reload skipped/i));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});

		it("persists only revision provenance independent of secret-shaped workflow content", async () => {
			const sequences: number[][] = [];
			for (const secret of ["sk-aaaaaaaaaaaaaaaaaaaa", "sk-bbbbbbbbbbbbbbbbbbbb"]) {
				const host = new FakeHost();
				let calls = 0;
				await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }]), input: "task", cwd: "/tmp", host, reload: async () => ({ workflow: ++calls === 2 ? workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: secret }]) : undefined }) });
				sequences.push(host.checkpoints.map((entry) => entry.definitionRevision ?? -1));
				expect(host.checkpoints.every((entry) => !("definitionFingerprint" in entry))).toBe(true);
			}
			expect(sequences[0]).toEqual(sequences[1]);
		});

		it("increments a bounded definition revision only after successful swaps", async () => {
			const host = new FakeHost();
			let calls = 0;
			const changed = workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "changed" }]);
			await runWorkflow({ workflow: workflow([{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }]), input: "task", cwd: "/tmp", host, reload: async () => calls++ === 1 ? ({ workflow: changed }) : ({ warning: calls > 2 ? "invalid" : undefined }) });
			expect(new Set(host.checkpoints.map((entry) => entry.definitionRevision))).toEqual(new Set([0, 1]));
		});

		it("does not let persisted malformed revision metadata affect execution", () => {
			const parsed = toAnvilCheckpoint({ customType: "anvil-run", data: { runId: "r", workflowName: "w", input: "i", phase: "run_start", timestamp: "now", definitionRevision: Number.MAX_VALUE, definitionFingerprint: "../../secret" } });
			expect(parsed).toBeDefined();
			expect(parsed?.definitionRevision).toBeUndefined();
			expect(parsed).not.toHaveProperty("definitionFingerprint");
		});
	});
});

function workflow(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
	return { name: "test-workflow", steps };
}

function cloneSelection(selection: StepModelSelection | undefined): StepModelSelection | undefined {
	return selection ? { ...selection } : undefined;
}
