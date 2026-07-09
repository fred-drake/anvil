import type { RunSummary, StepRunState } from "./engine.ts";

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
): string[] | undefined {
	if (steps.length === 0) return undefined;
	return steps.map((step) => {
		const icon = iconForStep(step, currentStepId);
		const loopSuffix = step.loops > 0 ? ` ↻(${step.loops})` : "";
		const title = step.title ? ` — ${step.title}` : "";
		const checkSummary = step.checks.length > 0 ? ` [${step.checks.filter((c) => c.pass).length}/${step.checks.length} checks]` : "";
		const itemSuffix = item && step.id === currentStepId ? ` — item ${item.index + 1}/${item.count}` : "";
		return `${icon} ${step.id}${title}${loopSuffix}${checkSummary}${itemSuffix}`;
	});
}

export function renderSummaryMarkdown(summary: RunSummary): string {
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

	return lines.join("\n");
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
