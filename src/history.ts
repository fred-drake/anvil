import type { AnvilCheckpoint, RunSummary, WorkspaceState } from "./engine.ts";
import { isBoundedStepOutput } from "./step-output.ts";

export const HISTORY_LIMITS = {
	entryCount: 2_000,
	runCount: 50,
	checkpointCount: 200,
	checkCount: 100,
	pathCount: 25,
	stringLength: 500,
} as const;

export interface RunCheckReport {
	id: string;
	type: "deterministic" | "agent" | "unknown";
	pass: boolean;
	reason?: string;
	command?: string;
	timeoutMs?: number;
	timestamp?: string;
}

export interface RunStepReport {
	id: string;
	index?: number;
	status: "passed" | "failed" | "incomplete";
	startCount: number;
	retryCount: number;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	checks: RunCheckReport[];
	failureReason?: string;
}

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
	lastStepId?: string;
	failingStepId?: string;
	checksRun: number;
	checksFailed: number;
	failureReason?: string;
	loopTotals: Record<string, number>;
	truncation: string[];
}

export interface RunReport extends RunHistoryEntry {
	/** Bounded, validated, display-safe checkpoints retained for compatibility and evidence rendering. */
	checkpoints: AnvilCheckpoint[];
	steps: RunStepReport[];
	workspaceState?: WorkspaceState;
}

export interface ResumeRecoveryState {
	lastStepId?: string;
	completedStepIds: string[];
	outputs: Record<string, string>;
}

const phases = new Set<AnvilCheckpoint["phase"]>(["run_start", "step_start", "check_result", "step_pass", "run_end"]);
const finalStates = new Set<RunSummary["state"]>(["succeeded", "failed", "aborted"]);
const diagnosticPattern = /\b(?:provider|child|reviewer|transport)\b[^\n]*(?:error|diagnostic|failure)|(?:error|diagnostic|failure)[^\n]*\b(?:provider|child|reviewer|transport)\b/i;
const credentialPattern = /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const credentialValuePattern = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g;
const urlUserinfoPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const sensitiveOptionPattern = /(--(?:password|token|secret))(?:\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const stepAttemptIdentities = new WeakMap<RunStepReport, Set<string>>();
const sensitivePathPattern = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.gnupg|credentials?|secrets?|passwd|shadow|keychains?)(?:[/\\]|$)|(?:^|[/\\])id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/\\]+)?$/i;

/**
 * Extract a strictly validated, display-safe checkpoint from an untrusted Pi session entry.
 * Invalid optional fields are discarded rather than cast into the trusted engine contract.
 */
export function toAnvilCheckpoint(entry: unknown): AnvilCheckpoint | undefined {
	if (!isRecord(entry) || entry.customType !== "anvil-run") return undefined;
	const data = isRecord(entry.data) ? entry.data : isRecord(entry.details) ? entry.details : undefined;
	if (!data) return undefined;
	if (!isString(data.runId) || !isString(data.workflowName) || !isString(data.input) || !isString(data.phase) || !phases.has(data.phase as AnvilCheckpoint["phase"])) {
		return undefined;
	}

	const checkpoint: AnvilCheckpoint = {
		runId: sanitizeDisplay(data.runId),
		workflowName: sanitizeDisplay(data.workflowName),
		input: sanitizeDisplay(data.input),
		phase: data.phase as AnvilCheckpoint["phase"],
		timestamp: isString(data.timestamp) ? sanitizeDisplay(data.timestamp) : "unknown",
	};
	copyString(data, checkpoint, "workflowFile", true);
	if (Number.isInteger(data.definitionRevision) && (data.definitionRevision as number) >= 0 && (data.definitionRevision as number) <= 1_000_000) {
		checkpoint.definitionRevision = data.definitionRevision as number;
	}
	copyString(data, checkpoint, "stepId");
	copyInteger(data, checkpoint, "stepIndex");
	copyString(data, checkpoint, "checkId");
	copyInteger(data, checkpoint, "itemIndex");
	copyInteger(data, checkpoint, "itemCount");
	if (typeof data.pass === "boolean") checkpoint.pass = data.pass;
	copyReason(data, checkpoint, "reason");
	if (data.checkType === "deterministic" || data.checkType === "agent") checkpoint.checkType = data.checkType;
	copyString(data, checkpoint, "command");
	copyInteger(data, checkpoint, "timeoutMs");
	const workspace = sanitizeWorkspace(data.workspaceState);
	if (workspace) checkpoint.workspaceState = workspace;
	const loops = sanitizeLoopCounts(data.loopCounts);
	if (loops) checkpoint.loopCounts = loops;
	if (isString(data.finalState) && finalStates.has(data.finalState as RunSummary["state"])) checkpoint.finalState = data.finalState as RunSummary["state"];
	return checkpoint;
}

/**
 * Recover only the original task input from a structurally valid terminal entry.
 * This is intentionally separate from the presentation-safe checkpoint parser so
 * resume execution does not consume display-redacted data.
 */
export function rawInputFromTerminalCheckpoint(entry: unknown): string | undefined {
	const data = rawCheckpointData(entry);
	if (!data || data.phase !== "run_end") return undefined;
	if (!isString(data.runId) || !isString(data.workflowName) || !isString(data.input)) return undefined;
	return data.input;
}

/**
 * Fold untrusted checkpoints into execution-only resume state through one selected terminal entry.
 * Raw output is intentionally never routed through the presentation checkpoint parser.
 */
export function recoverResumeState(entries: unknown[], runId: string, terminalIndex: number): ResumeRecoveryState | undefined {
	if (!Number.isInteger(terminalIndex) || terminalIndex < 0 || terminalIndex >= entries.length) return undefined;
	const terminal = strictRawCheckpoint(entries[terminalIndex]);
	if (!terminal || terminal.phase !== "run_end" || terminal.runId !== runId) return undefined;

	const completed = new Set<string>();
	const outputs = Object.create(null) as Record<string, string>;
	let lastStepId: string | undefined;
	const startIndex = Math.max(0, terminalIndex - HISTORY_LIMITS.entryCount + 1);
	for (let index = startIndex; index <= terminalIndex; index += 1) {
		const checkpoint = strictRawCheckpoint(entries[index]);
		if (!checkpoint || checkpoint.runId !== runId || checkpoint.workflowName !== terminal.workflowName || checkpoint.input !== terminal.input) continue;
		if (checkpoint.phase === "step_start" && checkpoint.stepId) {
			lastStepId = checkpoint.stepId;
			completed.delete(checkpoint.stepId);
			delete outputs[checkpoint.stepId];
		}
		if (checkpoint.phase !== "step_pass" || !checkpoint.stepId) continue;
		completed.add(checkpoint.stepId);
		delete outputs[checkpoint.stepId];
		if (typeof checkpoint.output === "string" && isBoundedStepOutput(checkpoint.output)) {
			outputs[checkpoint.stepId] = checkpoint.output;
		}
	}
	return { lastStepId, completedStepIds: [...completed], outputs };
}

/** Fold only the newest bounded checkpoint window into chronological per-run reports. */
export function buildRunReports(entries: unknown[]): RunReport[] {
	const sourceTruncated = entries.length > HISTORY_LIMITS.entryCount;
	const boundedEntries = entries.slice(-HISTORY_LIMITS.entryCount);
	const reports = new Map<string, RunReport>();
	let runsTruncated = false;

	for (const entry of boundedEntries) {
		const checkpoint = toAnvilCheckpoint(entry);
		if (!checkpoint) continue;
		let report = reports.get(checkpoint.runId);
		if (!report) {
			if (reports.size >= HISTORY_LIMITS.runCount) {
				const oldest = reports.keys().next().value as string | undefined;
				if (oldest) reports.delete(oldest);
				runsTruncated = true;
			}
			report = newRunReport(checkpoint);
			reports.set(checkpoint.runId, report);
		}
		if (report.checkpoints.length < HISTORY_LIMITS.checkpointCount) report.checkpoints.push(checkpoint);
		else addTruncation(report, "Checkpoint details were truncated.");
		applyCheckpoint(report, checkpoint);
	}

	for (const report of reports.values()) {
		finalizeSteps(report);
		if (sourceTruncated) addTruncation(report, "Older session entries were omitted before folding.");
		if (runsTruncated) addTruncation(report, "Older runs were omitted.");
	}
	return [...reports.values()];
}

/** Produce bounded lightweight history rows in chronological first-seen order. */
export function buildRunHistory(entries: unknown[]): RunHistoryEntry[] {
	return buildRunReports(entries).map(({ checkpoints: _checkpoints, steps: _steps, workspaceState: _workspace, ...entry }) => entry);
}

function newRunReport(checkpoint: AnvilCheckpoint): RunReport {
	return {
		runId: checkpoint.runId,
		workflowName: checkpoint.workflowName,
		input: checkpoint.input,
		stepsStarted: 0,
		checksRun: 0,
		checksFailed: 0,
		loopTotals: {},
		truncation: [],
		checkpoints: [],
		steps: [],
	};
}

function applyCheckpoint(report: RunReport, checkpoint: AnvilCheckpoint): void {
	if (checkpoint.phase === "run_start") report.startedAt = validTimestamp(checkpoint.timestamp);
	if (checkpoint.phase === "step_start" && checkpoint.stepId) {
		const step = getStep(report, checkpoint.stepId, checkpoint.stepIndex);
		const attempts = stepAttemptIdentities.get(step) ?? new Set<string>();
		const attemptIdentity = `${checkpoint.stepId}:${checkpoint.itemIndex ?? "step"}`;
		if (attempts.has(attemptIdentity)) step.retryCount += 1;
		else attempts.add(attemptIdentity);
		stepAttemptIdentities.set(step, attempts);
		step.startCount += 1;
		step.startedAt ??= validTimestamp(checkpoint.timestamp);
		report.stepsStarted += 1;
		report.lastStepId = checkpoint.stepId;
		if (checkpoint.stepIndex !== undefined) report.lastStepIndex = checkpoint.stepIndex;
	}
	if (checkpoint.phase === "check_result" && checkpoint.stepId && checkpoint.checkId && typeof checkpoint.pass === "boolean") {
		report.checksRun += 1;
		if (!checkpoint.pass) report.checksFailed += 1;
		const checkCount = report.steps.reduce((count, step) => count + step.checks.length, 0);
		if (checkCount < HISTORY_LIMITS.checkCount) {
			const step = getStep(report, checkpoint.stepId, checkpoint.stepIndex);
			step.checks.push({
				id: checkpoint.checkId,
				type: checkpoint.checkType ?? "unknown",
				pass: checkpoint.pass,
				reason: checkpoint.reason,
				command: checkpoint.command,
				timeoutMs: checkpoint.timeoutMs,
				timestamp: validTimestamp(checkpoint.timestamp),
			});
			if (!checkpoint.pass) step.failureReason = checkpoint.reason;
		} else addTruncation(report, "Check details were truncated.");
	}
	if (checkpoint.phase === "step_pass" && checkpoint.stepId) {
		const step = getStep(report, checkpoint.stepId, checkpoint.stepIndex);
		step.status = "passed";
		step.endedAt = validTimestamp(checkpoint.timestamp);
		step.durationMs = durationMs(step.startedAt, step.endedAt);
	}
	if (checkpoint.loopCounts) report.loopTotals = { ...checkpoint.loopCounts };
	if (checkpoint.workspaceState) {
		report.workspaceState = checkpoint.workspaceState;
		if (checkpoint.workspaceState.changedFiles.length >= HISTORY_LIMITS.pathCount && checkpoint.workspaceState.changedFileCount > checkpoint.workspaceState.changedFiles.length) {
			addTruncation(report, "Changed-file paths were truncated.");
		}
	}
	if (checkpoint.phase !== "run_end") return;

	report.endedAt = validTimestamp(checkpoint.timestamp);
	report.finalState = checkpoint.finalState;
	report.failureReason = checkpoint.reason;
	report.durationMs = durationMs(report.startedAt, report.endedAt);
}

function getStep(report: RunReport, id: string, index?: number): RunStepReport {
	let step = report.steps.find((candidate) => candidate.id === id);
	if (!step) {
		step = { id, index, status: "incomplete", startCount: 0, retryCount: 0, checks: [] };
		report.steps.push(step);
	} else if (step.index === undefined) step.index = index;
	return step;
}

function finalizeSteps(report: RunReport): void {
	const active = report.lastStepId ? report.steps.find((step) => step.id === report.lastStepId && step.status !== "passed") : undefined;
	if (active && report.finalState === "failed") {
		active.status = "failed";
		active.endedAt = report.endedAt;
		active.durationMs = durationMs(active.startedAt, active.endedAt);
		active.failureReason = report.failureReason ?? active.failureReason;
		report.failingStepId = active.id;
	}
}

function sanitizeWorkspace(value: unknown): WorkspaceState | undefined {
	if (!isRecord(value) || !isString(value.head) || !isString(value.fingerprint) || !Array.isArray(value.changedFiles) || !Number.isInteger(value.changedFileCount) || (value.changedFileCount as number) < 0) return undefined;
	return {
		head: sanitizeDisplay(value.head),
		fingerprint: sanitizeDisplay(value.fingerprint),
		changedFiles: sanitizePaths(value.changedFiles),
		changedFileCount: value.changedFileCount as number,
	};
}

function sanitizeLoopCounts(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, number> = {};
	for (const [key, count] of Object.entries(value).slice(0, HISTORY_LIMITS.checkCount)) {
		if (Number.isInteger(count) && (count as number) >= 0) result[sanitizeDisplay(key)] = count as number;
	}
	return result;
}

function sanitizePaths(values: unknown[]): string[] {
	const bounded = values.slice(0, HISTORY_LIMITS.pathCount);
	if (!bounded.every(isString)) return [];
	return bounded.map(sanitizePath);
}

function sanitizePath(value: string): string {
	if (sensitivePathPattern.test(value)) return "[sensitive path redacted]";
	return sanitizeDisplay(value);
}

function sanitizeReason(value: string): string {
	if (diagnosticPattern.test(value)) return "[external diagnostic redacted]";
	return sanitizeDisplay(value);
}

function sanitizeDisplay(value: string): string {
	const redacted = value
		.replace(urlUserinfoPattern, "$1[userinfo redacted]@")
		.replace(sensitiveOptionPattern, "$1 [redacted]")
		.replace(credentialPattern, "$1=[redacted]")
		.replace(credentialValuePattern, "[credential redacted]")
		.replace(/\b(?:javascript|data|vbscript)\s*:/gi, "[unsafe scheme redacted]");
	const plain = redacted
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replaceAll("`", "'")
		.replaceAll("|", "¦")
		.replaceAll("<", "‹")
		.replaceAll(">", "›")
		.replaceAll("[", "［")
		.replaceAll("]", "］")
		.replaceAll("\\", "/")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > HISTORY_LIMITS.stringLength ? `${plain.slice(0, HISTORY_LIMITS.stringLength)}…` : plain;
}

function copyString(source: Record<string, unknown>, target: AnvilCheckpoint, key: "workflowFile" | "stepId" | "checkId" | "command", path = false): void {
	const value = source[key];
	if (isString(value)) target[key] = path ? sanitizePath(value) : sanitizeDisplay(value);
}

function copyReason(source: Record<string, unknown>, target: AnvilCheckpoint, key: "reason"): void {
	const value = source[key];
	if (isString(value)) target[key] = sanitizeReason(value);
}

function copyInteger(source: Record<string, unknown>, target: AnvilCheckpoint, key: "stepIndex" | "itemIndex" | "itemCount" | "timeoutMs"): void {
	const value = source[key];
	if (Number.isInteger(value) && (value as number) >= 0) target[key] = value as number;
}

function addTruncation(report: RunReport, message: string): void {
	if (!report.truncation.includes(message)) report.truncation.push(message);
}

function validTimestamp(value: string): string | undefined {
	return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function durationMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
	if (!startedAt || !endedAt) return undefined;
	const duration = Date.parse(endedAt) - Date.parse(startedAt);
	return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

type RawCheckpoint = {
	runId: string;
	workflowName: string;
	input: string;
	phase: AnvilCheckpoint["phase"];
	timestamp: string;
	stepId?: string;
	output?: unknown;
};

function strictRawCheckpoint(entry: unknown): RawCheckpoint | undefined {
	const data = rawCheckpointData(entry);
	if (!data || !isString(data.runId) || !isString(data.workflowName) || !isString(data.input) || !isString(data.timestamp)) return undefined;
	if (!isString(data.phase) || !phases.has(data.phase as AnvilCheckpoint["phase"])) return undefined;
	if ((data.phase === "step_start" || data.phase === "step_pass") && (!isString(data.stepId) || data.stepId.length === 0)) return undefined;
	return {
		runId: data.runId,
		workflowName: data.workflowName,
		input: data.input,
		phase: data.phase as AnvilCheckpoint["phase"],
		timestamp: data.timestamp,
		stepId: isString(data.stepId) ? data.stepId : undefined,
		output: data.output,
	};
}

function rawCheckpointData(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry) || entry.customType !== "anvil-run") return undefined;
	return isRecord(entry.data) ? entry.data : isRecord(entry.details) ? entry.details : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
