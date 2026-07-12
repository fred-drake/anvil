import { describe, expect, it } from "vitest";
import { buildRunHistory, buildRunReports, HISTORY_LIMITS } from "../src/history.ts";
import { renderRunReport } from "../src/ui.ts";

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
		expect(buildRunHistory([{ customType: "other", data: base }, entry({ timestamp: "2026-07-10T10:00:00.000Z" })])).toEqual([]);
	});

	it("reconstructs each step's passed, failed, and incomplete status with start/end timing and the last failing step", () => {
		const reports = buildRunReports([
			entry({ phase: "run_start", timestamp: "2026-07-10T10:00:00.000Z" }),
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:01.000Z", stepId: "plan", stepIndex: 0 }),
			entry({ phase: "step_pass", timestamp: "2026-07-10T10:00:02.000Z", stepId: "plan", stepIndex: 0 }),
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:03.000Z", stepId: "implement", stepIndex: 1 }),
			entry({ phase: "run_end", timestamp: "2026-07-10T10:00:05.000Z", finalState: "failed", reason: "tests failed" }),
		]);

		expect(reports[0]?.steps).toMatchObject([
			{ id: "plan", status: "passed", durationMs: 1000 },
			{ id: "implement", status: "failed", durationMs: 2000 },
		]);
		expect(reports[0]).toMatchObject({ lastStepId: "implement", failingStepId: "implement" });
	});

	it("counts retries from repeated step starts and preserves deterministic and agent-check verdicts per step", () => {
		const [report] = buildRunReports([
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:01.000Z", stepId: "verify", stepIndex: 0 }),
			entry({ phase: "check_result", timestamp: "2026-07-10T10:00:02.000Z", stepId: "verify", checkId: "tests", checkType: "deterministic", command: "npm test", pass: false, reason: "failed" }),
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:03.000Z", stepId: "verify", stepIndex: 0 }),
			entry({ phase: "check_result", timestamp: "2026-07-10T10:00:04.000Z", stepId: "verify", checkId: "review", checkType: "agent", pass: true, reason: "approved" }),
			entry({ phase: "step_pass", timestamp: "2026-07-10T10:00:05.000Z", stepId: "verify", stepIndex: 0 }),
		]);

		expect(report?.steps[0]).toMatchObject({ retryCount: 1, status: "passed" });
		expect(report?.steps[0]?.checks).toMatchObject([
			{ id: "tests", type: "deterministic", pass: false, command: "npm test" },
			{ id: "review", type: "agent", pass: true, reason: "approved" },
		]);
	});

	it("tracks forEach retries by item identity instead of treating distinct first attempts as retries", () => {
		const [report] = buildRunReports([
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:01.000Z", stepId: "verify", stepIndex: 0, itemIndex: 0 }),
			entry({ phase: "step_start", timestamp: "2026-07-10T10:00:02.000Z", stepId: "verify", stepIndex: 0, itemIndex: 1 }),
		]);

		expect(report?.steps[0]).toMatchObject({ startCount: 2, retryCount: 0 });
	});

	it("keeps chronological multi-run folding deterministic when timestamps are missing or invalid and reports incomplete runs", () => {
		const reports = buildRunReports([
			entry({ runId: "old", phase: "run_start", timestamp: "invalid" }),
			entry({ runId: "new", phase: "run_start", timestamp: undefined }),
			entry({ runId: "old", phase: "step_start", timestamp: "also-invalid", stepId: "one" }),
		]);

		expect(reports.map((report) => report.runId)).toEqual(["old", "new"]);
		expect(reports[0]?.lastStepId).toBe("one");
		expect(reports[0]?.finalState).toBeUndefined();
		expect(reports[0]?.durationMs).toBeUndefined();
		expect(reports[0]?.steps[0]?.status).toBe("incomplete");
	});

	it("bounds raw entries before folding and caps runs, checkpoints, checks, changed files, session paths, and display strings with truncation metadata", () => {
		const oversized = "x".repeat(HISTORY_LIMITS.stringLength * 2);
		const entries = Array.from({ length: HISTORY_LIMITS.entryCount + 20 }, (_, index) => entry({
			runId: `run-${index}`,
			phase: "run_end",
			timestamp: "2026-07-10T10:00:00.000Z",
			finalState: "failed",
			reason: oversized,
			sessionFiles: Array.from({ length: HISTORY_LIMITS.pathCount + 5 }, (__, pathIndex) => `/tmp/${pathIndex}.jsonl`),
			workspaceState: { head: "abc", fingerprint: "hash", changedFiles: Array.from({ length: HISTORY_LIMITS.pathCount + 5 }, (__, pathIndex) => `src/${pathIndex}.ts`), changedFileCount: 999 },
		}));
		const reports = buildRunReports(entries);

		expect(reports).toHaveLength(HISTORY_LIMITS.runCount);
		expect(reports.at(-1)?.failureReason?.length).toBeLessThanOrEqual(HISTORY_LIMITS.stringLength + 1);
		expect(reports.at(-1)?.subagentSessions).toHaveLength(HISTORY_LIMITS.pathCount);
		expect(reports.at(-1)?.workspaceState?.changedFiles).toHaveLength(HISTORY_LIMITS.pathCount);
		expect(reports.at(-1)?.truncation.length).toBeGreaterThan(0);
	});

	it("discards wrong-typed checkpoint fields without throwing or retaining unbounded raw payloads", () => {
		const [report] = buildRunReports([entry({
			phase: "check_result", timestamp: "2026-07-10T10:00:00.000Z", stepId: 42, checkId: {}, checkType: "shell",
			command: ["npm", "test"], reason: { secret: "value" }, timeoutMs: "forever", pass: "yes", sessionFiles: ["/ok", 7],
			workspaceState: { head: 1, fingerprint: [], changedFiles: "all", changedFileCount: "many" }, loopCounts: { verify: "lots" },
		})]);

		expect(report).toMatchObject({ checksRun: 0, subagentSessions: [] });
		expect(report?.checkpoints[0]).not.toHaveProperty("command");
		expect(report?.workspaceState).toBeUndefined();
	});

	it("sanitizes every checkpoint-derived field and redacts credential-shaped values and secret-like workspace or session paths", () => {
		const hostile = "bad`|\n<script>[x](javascript:alert(1)) TOKEN=top-secret\u0000";
		const [report] = buildRunReports([{ customType: "anvil-run", data: {
			runId: hostile, workflowName: hostile, input: hostile, phase: "run_end", timestamp: hostile,
			finalState: "failed", reason: hostile, sessionFiles: ["/home/me/.ssh/id_rsa", "/tmp/safe.jsonl"],
			workspaceState: { head: hostile, fingerprint: hostile, changedFiles: [".env", "src/safe.ts"], changedFileCount: 2 },
		} }]);

		expect(JSON.stringify(report)).not.toMatch(/top-secret|<script>|javascript:|id_rsa|\.env/);
		expect(report?.subagentSessions).toEqual(["[sensitive path redacted]", "/tmp/safe.jsonl"]);
		expect(report?.workspaceState?.changedFiles).toEqual(["[sensitive path redacted]", "src/safe.ts"]);
	});

	it("redacts URL userinfo and sensitive CLI option values from rendered reports", () => {
		const secrets = ["url-password", "space-password", "equals-token", "quoted-secret"];
		const [report] = buildRunReports([entry({
			phase: "check_result", timestamp: "2026-07-10T10:00:00.000Z", stepId: "verify", checkId: "credentials", pass: false,
			command: "curl https://user:url-password@example.test --password space-password --token=equals-token --secret 'quoted-secret'",
			reason: "retry https://another:reason-password@example.test with --password=reason-secret",
		})]);

		const rendered = renderRunReport(report!);
		for (const secret of [...secrets, "reason-password", "reason-secret"]) expect(rendered).not.toContain(secret);
		expect(rendered).toMatch(/redacted/i);
	});

	it("uses fixed parent-controlled diagnostics instead of persisted provider, child, or reviewer diagnostic prose", () => {
		const [report] = buildRunReports([entry({
			phase: "run_end", timestamp: "2026-07-10T10:00:00.000Z", finalState: "failed",
			reason: "Provider error: raw child diagnostic API_TOKEN=steal-me from reviewer transport",
		})]);

		expect(report?.failureReason).toBe("[external diagnostic redacted]");
		expect(JSON.stringify(report)).not.toContain("steal-me");
	});

	it("remains a presentation-only reader without filesystem traversal, realpath resolution, symlink access, or subprocess execution", () => {
		expect(() => buildRunReports([entry({
			phase: "run_end", timestamp: "2026-07-10T10:00:00.000Z", finalState: "succeeded",
			sessionFiles: ["/does/not/exist", "../../etc/passwd"],
		})])).not.toThrow();
	});
});
