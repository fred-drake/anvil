import type { AnvilCheckpoint, RunSummary } from "./engine.ts";

export interface RunHistoryEntry {
	runId: string;
	workflowName: string;
	input: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	finalState?: RunSummary["state"];
	stepsStarted: number;
	lastStepIndex?: number;
	checksRun: number;
	checksFailed: number;
	failureReason?: string;
	loopTotals: Record<string, number>;
}

export interface RunReport extends RunHistoryEntry {
	checkpoints: AnvilCheckpoint[];
	subagentSessions: string[];
}

/**
 * Extracts Anvil's append-only checkpoint payload from a Pi session entry.
 * Keeping this reader tolerant lets reports render older session logs too.
 */
export function toAnvilCheckpoint(entry: unknown): AnvilCheckpoint | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	const data = record.customType === "anvil-run" ? (record.data ?? record.details ?? record) : undefined;
	if (!data || typeof data !== "object") return undefined;
	const checkpoint = data as Partial<AnvilCheckpoint>;
	if (typeof checkpoint.runId !== "string" || typeof checkpoint.workflowName !== "string" || typeof checkpoint.input !== "string") {
		return undefined;
	}
	if (typeof checkpoint.phase !== "string" || typeof checkpoint.timestamp !== "string") return undefined;
	return checkpoint as AnvilCheckpoint;
}

/** Folds Anvil checkpoint entries into chronological, detailed per-run reports. */
export function buildRunReports(entries: unknown[]): RunReport[] {
	const reports = new Map<string, RunReport>();
	for (const entry of entries) {
		const checkpoint = toAnvilCheckpoint(entry);
		if (!checkpoint) continue;
		let report = reports.get(checkpoint.runId);
		if (!report) {
			report = {
			...newRunHistoryEntry(checkpoint),
			checkpoints: [],
			subagentSessions: [],
		};
			reports.set(checkpoint.runId, report);
		}
		report.checkpoints.push(checkpoint);
		applyCheckpoint(report, checkpoint);
	}
	return [...reports.values()];
}

/** Produces lightweight history rows in chronological order. */
export function buildRunHistory(entries: unknown[]): RunHistoryEntry[] {
	return buildRunReports(entries).map(({ checkpoints: _checkpoints, subagentSessions: _sessions, ...entry }) => entry);
}

function newRunHistoryEntry(checkpoint: AnvilCheckpoint): RunHistoryEntry {
	return {
		runId: checkpoint.runId,
		workflowName: checkpoint.workflowName,
		input: checkpoint.input,
		stepsStarted: 0,
		checksRun: 0,
		checksFailed: 0,
		loopTotals: {},
	};
}

function applyCheckpoint(report: RunReport, checkpoint: AnvilCheckpoint): void {
	if (checkpoint.phase === "run_start") report.startedAt = checkpoint.timestamp;
	if (checkpoint.phase === "step_start") {
		report.stepsStarted += 1;
		if (typeof checkpoint.stepIndex === "number") report.lastStepIndex = checkpoint.stepIndex;
	}
	if (checkpoint.phase === "check_result") {
		report.checksRun += 1;
		if (checkpoint.pass === false) report.checksFailed += 1;
	}
	if (checkpoint.loopCounts) report.loopTotals = { ...checkpoint.loopCounts };
	if (checkpoint.sessionFile && !report.subagentSessions.includes(checkpoint.sessionFile)) report.subagentSessions.push(checkpoint.sessionFile);
	for (const sessionFile of checkpoint.sessionFiles ?? []) {
		if (!report.subagentSessions.includes(sessionFile)) report.subagentSessions.push(sessionFile);
	}
	if (checkpoint.phase !== "run_end") return;

	report.endedAt = checkpoint.timestamp;
	report.finalState = checkpoint.finalState;
	report.failureReason = checkpoint.reason;
	report.durationMs = durationMs(report.startedAt, report.endedAt);
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
	if (!startedAt || !endedAt) return undefined;
	const duration = Date.parse(endedAt) - Date.parse(startedAt);
	return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
