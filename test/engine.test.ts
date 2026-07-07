import { describe, expect, it } from "vitest";
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

class FakeHost implements EngineHost {
	instructions: string[] = [];
	checkpoints: AnvilCheckpoint[] = [];
	notifications: string[] = [];
	statuses: Array<string | undefined> = [];
	widgets: Array<string[] | undefined> = [];
	summaries: RunSummary[] = [];
	execQueue: EngineExecResult[] = [];
	modelSelections: Array<StepModelSelection | undefined> = [];
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
		this.modelSelections.push(selection);
		if (this.modelSelectionError) throw this.modelSelectionError;
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

	async awaitVerdict(): Promise<Verdict | undefined> {
		return undefined;
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
		]);
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
		expect(host.modelSelections).toEqual([undefined]);
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

	it("runs subagent-delegated steps through host.runSubagent instead of the main session", async () => {
		const host = new FakeHost();
		host.enableSubagents();
		const summary = await runWorkflow({
			workflow: {
				...workflow([{ id: "one", title: "Implement", prompt: "Do {input}", model: "openai-codex/gpt-5.5:high" }]),
				defaults: { delegation: { subagent: "cmux" } },
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
		expect(request.backend).toBe("cmux");
		expect(request.cwd).toBe("/repo");
		expect(request.stepTitle).toBe("Implement");
		expect(request.model).toBe("openai-codex/gpt-5.5");
		expect(request.thinkingLevel).toBe("high");
		expect(request.task).toContain("Do task");
		expect(request.task).toContain("subagent session executing this workflow step");
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
});

function workflow(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
	return { name: "test-workflow", steps };
}
