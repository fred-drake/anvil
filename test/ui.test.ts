import { describe, expect, it } from "vitest";
import type { RunSummary, StepRunState } from "../src/engine.ts";
import { formatStatus, formatStepWidget, renderSummaryMarkdown } from "../src/ui.ts";

describe("formatStatus", () => {
	it("formats lifecycle and step/check status text", () => {
		expect(formatStatus({ workflowName: "wf", phase: "starting" })).toBe("anvil: wf starting");
		expect(formatStatus({ workflowName: "wf", phase: "done" })).toBe("anvil: wf done");
		expect(formatStatus({ workflowName: "wf", phase: "failed" })).toBe("anvil: wf failed");
		expect(formatStatus({ workflowName: "wf", phase: "aborted" })).toBeUndefined();
		expect(formatStatus({ workflowName: "wf", phase: "step", stepIndex: 0, stepTotal: 2, stepTitle: "Build" })).toBe(
			"anvil: 1/2 Build",
		);
		expect(
			formatStatus({
				workflowName: "wf",
				phase: "check",
				stepIndex: 1,
				stepTotal: 2,
				stepTitle: "Verify",
				checkIndex: 0,
				checkTotal: 1,
				checkName: "tests",
			}),
		).toBe("anvil: 2/2 Verify — check 1/1 (tests)");
		expect(formatStatus({ workflowName: "wf", phase: "loop", stepIndex: 0, stepTotal: 1, stepTitle: "Retry" })).toBe(
			"anvil: 1/1 Retry — retrying",
		);
	});

	it("includes a forEach item counter in step, check, and loop phases", () => {
		expect(
			formatStatus({ workflowName: "wf", phase: "step", stepIndex: 1, stepTotal: 4, stepTitle: "Stubs", itemIndex: 2, itemCount: 12 }),
		).toBe("anvil: 2/4 Stubs — item 3/12");
		expect(
			formatStatus({
				workflowName: "wf",
				phase: "check",
				stepIndex: 1,
				stepTotal: 4,
				stepTitle: "Stubs",
				itemIndex: 2,
				itemCount: 12,
				checkIndex: 0,
				checkTotal: 1,
				checkName: "tests",
			}),
		).toBe("anvil: 2/4 Stubs — item 3/12 — check 1/1 (tests)");
		expect(
			formatStatus({ workflowName: "wf", phase: "loop", stepIndex: 1, stepTotal: 4, stepTitle: "Stubs", itemIndex: 0, itemCount: 3 }),
		).toBe("anvil: 2/4 Stubs — item 1/3 — retrying");
	});
});

describe("formatStepWidget", () => {
	it("formats empty, running, completed, skipped, continued, and failed steps", () => {
		expect(formatStepWidget([])).toBeUndefined();
		const steps: StepRunState[] = [
			{ id: "pending", status: "pending", loops: 0, checks: [] },
			{ id: "running", title: "Run", status: "running", loops: 1, checks: [{ id: "c1", name: "check", pass: true, reason: "ok" }] },
			{ id: "passed", status: "passed", loops: 0, checks: [] },
			{ id: "failed", status: "failed", loops: 0, checks: [{ id: "c2", name: "bad", pass: false, reason: "no" }] },
			{ id: "skipped", status: "skipped", loops: 0, checks: [] },
			{ id: "continued", status: "continued", loops: 0, checks: [] },
		];

		expect(formatStepWidget(steps, "running")).toEqual([
			"○ pending",
			"▶ running — Run ↻(1) [1/1 checks]",
			"✔ passed",
			"✖ failed [0/1 checks]",
			"↷ skipped",
			"⚠ continued",
		]);
	});

	it("appends a forEach item counter to the current running step only", () => {
		const steps: StepRunState[] = [
			{ id: "before", status: "passed", loops: 0, checks: [] },
			{ id: "fanout", title: "Stubs", status: "running", loops: 0, checks: [] },
		];

		expect(formatStepWidget(steps, "fanout", { index: 2, count: 5 })).toEqual([
			"✔ before",
			"▶ fanout — Stubs — item 3/5",
		]);
	});
});

describe("renderSummaryMarkdown", () => {
	it("renders successful, failed, and aborted summaries with escaped check details", () => {
		const base: RunSummary = {
			runId: "run",
			workflowName: "wf",
			input: "task",
			state: "failed",
			startedAt: "start",
			endedAt: "end",
			loopCounts: {},
			failureReason: "bad | reason",
			steps: [
				{
					id: "one|two",
					status: "failed",
					loops: 2,
					checks: [
						{ id: "ok", name: "ok|check", pass: true, reason: "fine" },
						{ id: "bad", name: "bad", pass: false, reason: "line1\nline2" },
					],
				},
			],
		};

		const failed = renderSummaryMarkdown(base);
		expect(failed).toContain("❌ **Anvil workflow `wf` failed**");
		expect(failed).toContain("`one\\|two`");
		expect(failed).toContain("✔ ok\\|check<br>✖ bad — line1 line2");
		expect(failed).toContain("Failure: bad | reason");
		expect(renderSummaryMarkdown({ ...base, state: "succeeded", failureReason: undefined })).toContain("✅");
		expect(renderSummaryMarkdown({ ...base, state: "aborted", failureReason: undefined })).toContain("⏹");
	});
});
