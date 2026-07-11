import type { RunSummary, StepRunState, WorkspaceState } from "./engine.ts";
import type { RunHistoryEntry, RunReport } from "./history.ts";

export interface StatusInfo {
	workflowName: string;
	stepIndex?: number;
	stepTotal?: number;
	stepTitle?: string;
	phase: "starting" | "step" | "check" | "loop" | "done" | "failed" | "aborted";
	checkIndex?: number;
	checkTotal?: number;
	checkName?: string;
	itemIndex?: number;
	itemCount?: number;
}

export function formatStatus(info: StatusInfo): string | undefined {
	if (info.phase === "done") return `anvil: ${info.workflowName} done`;
	if (info.phase === "failed") return `anvil: ${info.workflowName} failed`;
	if (info.phase === "aborted") return undefined;
	if (info.phase === "starting") return `anvil: ${info.workflowName} starting`;

	const step =
		info.stepIndex !== undefined && info.stepTotal !== undefined
			? `${info.stepIndex + 1}/${info.stepTotal}`
			: "?/?";
	const title = info.stepTitle ?? "step";
	const item = info.itemIndex !== undefined && info.itemCount !== undefined ? ` — item ${info.itemIndex + 1}/${info.itemCount}` : "";
	if (info.phase === "check") {
		const check =
			info.checkIndex !== undefined && info.checkTotal !== undefined
				? ` — check ${info.checkIndex + 1}/${info.checkTotal}`
				: " — check";
		return `anvil: ${step} ${title}${item}${check}${info.checkName ? ` (${info.checkName})` : ""}`;
	}
	if (info.phase === "loop") return `anvil: ${step} ${title}${item} — retrying`;
	return `anvil: ${step} ${title}${item}`;
}

export function formatStepWidget(
	steps: StepRunState[],
	currentStepId?: string,
	item?: { index: number; count: number },
	failureReason?: string,
): string[] | undefined {
	if (steps.length === 0) return undefined;
	const stepLines = steps.map((step) => {
		const icon = iconForStep(step, currentStepId);
		const loopSuffix = step.loops > 0 ? ` ↻(${step.loops})` : "";
		const title = step.title ? ` — ${step.title}` : "";
		const checkSummary = step.checks.length > 0 ? ` [${step.checks.filter((c) => c.pass).length}/${step.checks.length} checks]` : "";
		const itemSuffix = item && step.id === currentStepId ? ` — item ${item.index + 1}/${item.count}` : "";
		return `${icon} ${step.id}${title}${loopSuffix}${checkSummary}${itemSuffix}`;
	});
	return failureReason ? [`✖ Step failed: ${failureReason}`, ...stepLines] : stepLines;
}

export function renderSummaryMarkdown(summary: RunSummary): string {
	const evidence = summary.evidence ?? { subagentSessions: [] };
	const stateIcon = summary.state === "succeeded" ? "✅" : summary.state === "failed" ? "❌" : "⏹";
	const lines = [
		`${stateIcon} **Anvil workflow \`${summary.workflowName}\` ${summary.state}**`,
		"",
		`Run ID: \`${summary.runId}\``,
		"",
		"| Step | Status | Checks |",
		"| --- | --- | --- |",
	];

	for (const step of summary.steps) {
		const checks = step.checks.length === 0
			? "—"
			: step.checks
					.map((check) => `${check.pass ? "✔" : "✖"} ${escapePipes(check.name)}${check.pass ? "" : ` — ${escapePipes(check.reason)}`}`)
					.join("<br>");
		lines.push(`| \`${escapePipes(step.id)}\` | ${step.status}${step.loops ? ` ↻ ${step.loops}` : ""} | ${checks} |`);
	}

	if (summary.failureReason) {
		lines.push("", `Failure: ${summary.failureReason}`);
	}

	lines.push("", "## Run evidence", `Duration: ${formatDuration(durationMs(summary.startedAt, summary.endedAt))}`);
	lines.push(formatWorkspaceState(evidence.workspaceEnd));
	if (evidence.workspaceEnd?.changedFiles.length) {
		lines.push("Workspace files changed (may include pre-existing changes):", ...evidence.workspaceEnd.changedFiles.map((file) => `- \`${file}\``));
	}
	if (evidence.subagentSessions.length > 0) {
		lines.push("Subagent sessions:", ...evidence.subagentSessions.map((file) => `- \`${file}\``));
	}
	lines.push(`Detailed report: \`/anvil report ${summary.runId}\``);
	return lines.join("\n");
}

export function renderRunHistoryTable(entries: RunHistoryEntry[], limit = 20): string {
	const recent = entries.slice(-limit).reverse();
	const lines = ["# Anvil run history", "", "| Run | Workflow | Started | Duration | State | Checks |", "| --- | --- | --- | --- | --- | --- |"];
	for (const entry of recent) {
		const state = entry.finalState === "succeeded" ? "✅" : entry.finalState === "failed" ? "❌" : entry.finalState === "aborted" ? "⏹" : "▶";
		lines.push(
			`| \`${escapePipes(entry.runId)}\` | \`${escapePipes(entry.workflowName)}\` | ${escapePipes(entry.startedAt ?? "unknown")} | ${formatDuration(entry.durationMs)} | ${state} | ${entry.checksRun - entry.checksFailed}/${entry.checksRun} |`,
		);
	}
	if (entries.length > limit) lines.push("", `Showing the ${limit} most recent of ${entries.length} runs.`);
	return lines.join("\n");
}

export function renderRunReport(report: RunReport): string {
	const state = report.finalState === "succeeded" ? "✅" : report.finalState === "failed" ? "❌" : report.finalState === "aborted" ? "⏹" : "▶";
	const lines = [
		`# ${state} Anvil run \`${report.runId}\``,
		"",
		`Workflow: \`${report.workflowName}\``,
		`Started: ${report.startedAt ?? "unknown"}`,
		`Ended: ${report.endedAt ?? "in progress"}`,
		`Duration: ${formatDuration(report.durationMs)}`,
		`Task input: ${report.input || "_(empty)_"}`,
		"",
		"## Checks",
		"",
		"| Step | Check | Type | Result | Evidence |",
		"| --- | --- | --- | --- | --- |",
	];
	const checks = report.checkpoints.filter((checkpoint) => checkpoint.phase === "check_result");
	if (checks.length === 0) lines.push("| — | — | — | — | No checks recorded |");
	for (const check of checks) {
		const evidence = [
			check.command ? `\`${escapePipes(check.command)}\`` : undefined,
			check.timeoutMs ? `${check.timeoutMs}ms timeout` : undefined,
			check.reason ? escapePipes(check.reason) : undefined,
		].filter(Boolean).join("<br>");
		lines.push(`| \`${escapePipes(check.stepId ?? "unknown")}\` | \`${escapePipes(check.checkId ?? "unknown")}\` | ${check.checkType ?? "unknown"} | ${check.pass ? "✔ pass" : "✖ fail"} | ${evidence || "—"} |`);
	}
	const endCheckpoint = [...report.checkpoints].reverse().find((checkpoint) => checkpoint.phase === "run_end");
	lines.push("", "## Workspace", formatWorkspaceState(endCheckpoint?.workspaceState));
	if (endCheckpoint?.workspaceState?.changedFiles.length) {
		lines.push("Workspace files changed (may include pre-existing changes):", ...endCheckpoint.workspaceState.changedFiles.map((file) => `- \`${file}\``));
	}
	if (report.subagentSessions.length > 0) lines.push("", "## Subagent sessions", ...report.subagentSessions.map((file) => `- \`${file}\``));
	if (report.failureReason) lines.push("", `Failure: ${report.failureReason}`);
	return lines.join("\n");
}

function formatWorkspaceState(state: WorkspaceState | undefined): string {
	if (!state) return "Git workspace: unavailable (not a Git worktree or Git could not be read).";
	return `Git workspace: \`${state.head}\`, ${state.changedFileCount} changed ${state.changedFileCount === 1 ? "file" : "files"} (fingerprint \`${state.fingerprint.slice(0, 12)}\`).`;
}

function durationMs(startedAt: string, endedAt: string): number | undefined {
	const duration = Date.parse(endedAt) - Date.parse(startedAt);
	return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatDuration(duration: number | undefined): string {
	if (duration === undefined) return "unknown";
	if (duration < 1_000) return `${duration}ms`;
	return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}

function iconForStep(step: StepRunState, currentStepId?: string): string {
	if (step.id === currentStepId && step.status === "running") return "▶";
	switch (step.status) {
		case "passed":
			return "✔";
		case "failed":
			return "✖";
		case "skipped":
			return "↷";
		case "continued":
			return "⚠";
		case "running":
			return "▶";
		default:
			return "○";
	}
}

function escapePipes(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
