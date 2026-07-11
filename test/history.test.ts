import { describe, expect, it } from "vitest";
import { buildRunHistory, buildRunReports } from "../src/history.ts";

const base = {
	runId: "run-1",
	workflowName: "forge",
	input: "add reports",
};

function entry(data: Record<string, unknown>) {
	return { customType: "anvil-run", data: { ...base, ...data } };
}

describe("run history", () => {
	it("folds automatic check evidence, workspace state, and subagent sessions into a report", () => {
		const entries = [
			entry({ phase: "run_start", timestamp: "2026-07-10T10:00:00.000Z" }),
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:01.000Z", stepId: "implement", stepIndex: 0 }),
			entry({
				phase: "check_result",
				timestamp: "2026-07-10T10:00:02.000Z",
				stepId: "implement",
				stepIndex: 0,
				checkId: "run-1:implement:0:0",
				checkType: "deterministic",
				command: "npm test",
				timeoutMs: 300000,
				pass: true,
				reason: "command exited 0",
			}),
			entry({
				phase: "run_end",
				timestamp: "2026-07-10T10:00:05.000Z",
				finalState: "succeeded",
				workspaceState: { head: "abc", fingerprint: "hash", changedFiles: ["src/history.ts"], changedFileCount: 1 },
				sessionFiles: ["/tmp/review.jsonl"],
			}),
		];

		const [report] = buildRunReports(entries);
		expect(report).toMatchObject({
			runId: "run-1",
			durationMs: 5000,
			stepsStarted: 1,
			checksRun: 1,
			checksFailed: 0,
			finalState: "succeeded",
			subagentSessions: ["/tmp/review.jsonl"],
		});
		expect(report?.checkpoints[2]).toMatchObject({ command: "npm test", checkType: "deterministic", timeoutMs: 300000 });
		expect(buildRunHistory(entries)[0]).not.toHaveProperty("checkpoints");
	});

	it("ignores unrelated or malformed session entries", () => {
		expect(buildRunHistory([{ customType: "other", data: base }, entry({ phase: "run_start" })])).toEqual([]);
	});
});
