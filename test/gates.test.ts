import { describe, expect, it } from "vitest";
import type { EngineHost, EngineExecOptions, EngineExecResult, RunSummary, AnvilCheckpoint } from "../src/engine.ts";
import { executeAgentCheck, executeDeterministicCheck, VerdictBus, type Verdict } from "../src/gates.ts";
import type { WorkflowDefinition } from "../src/types.ts";

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

function ctx() {
	return { input: "task", step: { id: "one", index: 0 }, loopCounts: {}, cwd: "/tmp" };
}
