import { describe, expect, it } from "vitest";
import type { EngineHost, EngineExecOptions, EngineExecResult, RunSummary, AnvilCheckpoint } from "../src/engine.ts";
import { executeAgentCheck, executeDeterministicCheck, VerdictBus, type Verdict } from "../src/gates.ts";
import type { WorkflowDefinition } from "../src/types.ts";

class GateHost implements EngineHost {
	instructions: string[] = [];
	execResult: EngineExecResult = { stdout: "", stderr: "", code: 0 };
	verdict: Verdict | undefined;
	neverVerdict = false;
	turns = 0;

	sendInstruction(instruction: string): void {
		this.instructions.push(instruction);
	}

	async waitForTurnComplete(): Promise<void> {
		this.turns += 1;
	}

	async exec(_command: string, _args: string[], _options?: EngineExecOptions): Promise<EngineExecResult> {
		return this.execResult;
	}

	async awaitVerdict(checkId: string): Promise<Verdict | undefined> {
		if (this.neverVerdict) return new Promise(() => undefined);
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
});

function workflow(): WorkflowDefinition {
	return { name: "test", steps: [{ id: "one", prompt: "do it" }] };
}

function ctx() {
	return { input: "task", step: { id: "one", index: 0 }, loopCounts: {}, cwd: "/tmp" };
}
