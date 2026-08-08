import {
	AnvilAbortError,
	isAnvilAbortError,
	isWorkflowInfrastructureError,
	throwIfAborted,
	WorkflowInfrastructureError,
} from "./errors.ts";
import { executeAgentCheck, executeDeterministicCheck, type GateResult, type Verdict } from "./gates.ts";
import {
	buildStepInstruction,
	buildSubagentStepTask,
	getCurrentLoopCount,
	renderCommandTemplatable,
	resolveStepDelegation,
} from "./prompts.ts";
import type {
	Check,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowStep,
	WorkflowSubagentBackend,
	WorkflowThinkingLevel,
} from "./types.ts";
import { captureObservableStepResult, type ObservableStepResult } from "./observable-result.ts";
import { truncateStepOutput } from "./step-output.ts";
import { formatStatus, formatStepWidget } from "./ui.ts";

export interface EngineExecOptions {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

export interface EngineExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export interface StepModelSelection {
	model?: string;
	thinkingLevel?: WorkflowThinkingLevel;
}

const THINKING_LEVELS = new Set<WorkflowThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface SubagentStepRunRequest {
	runId: string;
	workflowName: string;
	stepId: string;
	stepTitle: string;
	stepIndex: number;
	stepCount: number;
	backend: WorkflowSubagentBackend;
	/** Full task prompt for the subagent session. */
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: WorkflowThinkingLevel;
	timeoutMs?: number;
}

export interface SubagentStepRunResult {
	summary: string;
	sessionFile?: string;
	exitCode: number;
	errorMessage?: string;
}

export interface ReviewSubagentRunRequest {
	runId: string;
	workflowName: string;
	stepId: string;
	checkId: string;
	backend: WorkflowSubagentBackend;
	/** Complete review-only task prompt. */
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: WorkflowThinkingLevel;
	timeoutMs?: number;
}

export interface ReviewSubagentRunResult {
	pass: boolean;
	reason: string;
	sessionFile?: string;
	exitCode: number;
}

export interface WorkspaceState {
	/** Git commit at capture time, when the workflow cwd is a Git worktree. */
	head: string;
	/** Bounded fingerprint of the Git working-tree state. */
	fingerprint: string;
	changedFiles: string[];
	changedFileCount: number;
}

export interface RunEvidence {
	workspaceStart?: WorkspaceState;
	lastVerification?: WorkspaceState;
	workspaceEnd?: WorkspaceState;
	subagentSessions: string[];
}

export interface RunProgressSnapshot {
	readonly workflowName: string;
	readonly steps: ReadonlyArray<Readonly<{ id: string; title?: string }>>;
	readonly stepIndex?: number;
	readonly retryCount?: number;
}

export interface EngineHost {
	applyStepModelSelection?(selection: StepModelSelection | undefined): void | Promise<void>;
	/** Publish presentation-only progress from the authoritative active workflow definition. */
	setRunProgress?(snapshot: RunProgressSnapshot): void;
	/** Run a subagent-delegated step to completion. Required for workflows using delegation: { subagent }. */
	runSubagent?(request: SubagentStepRunRequest, signal?: AbortSignal): Promise<SubagentStepRunResult>;
	/** Run an agent check in a fresh review-only child session. */
	runReviewSubagent?(request: ReviewSubagentRunRequest, signal?: AbortSignal): Promise<ReviewSubagentRunResult>;
	/** Optional runtime availability probe used to honor reviewFallback before launch. */
	isReviewSubagentAvailable?(backend: WorkflowSubagentBackend): boolean;
	sendInstruction(instruction: string): void;
	waitForTurnComplete(signal?: AbortSignal): Promise<void>;
	exec(command: string, args: string[], options?: EngineExecOptions): Promise<EngineExecResult>;
	/** Returns a bounded Git workspace snapshot, or undefined outside a worktree. */
	captureWorkspaceState?(cwd: string, signal?: AbortSignal): Promise<WorkspaceState | undefined>;
	awaitVerdict(checkId: string, timeoutMs: number, signal?: AbortSignal): Promise<Verdict | undefined>;
	beginStepOutputCapture?(stepId: string): void;
	endStepOutputCapture?(stepId: string): string | undefined;
	checkpoint(entry: AnvilCheckpoint): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(text: string | undefined): void;
	setWidget(lines: string[] | undefined): void;
	postSummary(summary: RunSummary): void | Promise<void>;
}

export interface ResumeWorkflowOptions {
	/** One-based current-definition workflow step number to resume from. */
	stepNumber: number;
	/** Current retry/loop count for the resumed step. Defaults to 0. */
	retryCount?: number;
	/** Completed historical step ids recovered from the selected prior run. */
	completedStepIds?: string[];
	/** Bounded raw output snapshots recovered from completed historical steps. */
	outputs?: Record<string, string>;
}

export interface WorkflowReloadResult {
	/** A freshly loaded and validated candidate. Omit it to retain the active definition. */
	workflow?: WorkflowDefinition;
	/** Display-safe diagnostic code or message. The engine bounds and redacts it again. */
	warning?: string;
}

export interface RunWorkflowOptions {
	workflow: WorkflowDefinition;
	input: string;
	cwd: string;
	host: EngineHost;
	runId?: string;
	resume?: ResumeWorkflowOptions;
	signal?: AbortSignal;
	/** Opt-in development hook. Called only before binding the next outer-loop step. */
	reload?: () => Promise<WorkflowReloadResult>;
}

export type StepRunStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "continued";

export interface CheckRunState {
	id: string;
	name: string;
	type?: Check["type"];
	pass: boolean;
	reason: string;
	command?: string;
	timeoutMs?: number;
	workspaceState?: WorkspaceState;
}

export interface StepRunState {
	id: string;
	title?: string;
	status: StepRunStatus;
	loops: number;
	checks: CheckRunState[];
}

export interface RunSummary {
	runId: string;
	workflowName: string;
	input: string;
	state: "succeeded" | "failed" | "aborted";
	startedAt: string;
	endedAt: string;
	steps: StepRunState[];
	loopCounts: Record<string, number>;
	evidence?: RunEvidence;
	failureReason?: string;
}

export type AnvilCheckpointPhase = "run_start" | "step_start" | "check_result" | "step_pass" | "run_end";

export interface AnvilCheckpoint {
	runId: string;
	workflowName: string;
	input: string;
	phase: AnvilCheckpointPhase;
	timestamp: string;
	workflowFile?: string;
	/** Monotonic in-memory definition revision; presentation metadata only. */
	definitionRevision?: number;
	stepId?: string;
	stepIndex?: number;
	checkId?: string;
	itemIndex?: number;
	itemCount?: number;
	pass?: boolean;
	reason?: string;
	checkType?: Check["type"];
	command?: string;
	timeoutMs?: number;
	sessionFile?: string;
	sessionFiles?: string[];
	workspaceState?: WorkspaceState;
	loopCounts?: Record<string, number>;
	finalState?: RunSummary["state"];
	/** Execution-only bounded snapshot. Presentation readers deliberately omit this field. */
	output?: string;
}

interface FailureDecision {
	kind: "stop" | "continue" | "goto";
	reason?: string;
	targetIndex?: number;
	targetId?: string;
}

type CheckpointFn = (entry: Omit<AnvilCheckpoint, "runId" | "workflowName" | "input" | "timestamp">) => void;

export async function runWorkflow(initialOptions: RunWorkflowOptions): Promise<RunSummary> {
	const options: RunWorkflowOptions = { ...initialOptions };
	const runId = options.runId ?? newRunId();
	let activeWorkflow = options.workflow;
	const startedAt = new Date().toISOString();
	const loopCounts: Record<string, number> = {};
	const outputs = Object.create(null) as Record<string, string>;
	const feedbackByStep = new Map<string, string>();
	const attempts = new Map<string, number>();
	let workflowHasModelSelectionOverrides = hasWorkflowModelSelectionOverrides(activeWorkflow);
	const evidence: RunEvidence = { subagentSessions: [] };
	const freshness: { lastVerificationWorkspace?: WorkspaceState } = {};
	let shouldRestoreModelSelection = false;
	let steps = activeWorkflow.steps.map<StepRunState>((step) => ({
		id: step.id,
		title: step.title,
		status: "pending",
		loops: 0,
		checks: [],
	}));
	const resume = resolveResumeState(options, loopCounts, outputs, steps);
	let definitionRevision = 0;
	let pendingGotoTargetId: string | undefined;

	const checkpoint = (entry: Omit<AnvilCheckpoint, "runId" | "workflowName" | "input" | "timestamp">) => {
		options.host.checkpoint({
			runId,
			workflowName: activeWorkflow.name,
			input: options.input,
			timestamp: new Date().toISOString(),
			loopCounts: { ...loopCounts },
			definitionRevision,
			...entry,
		});
	};

	const finish = async (state: RunSummary["state"], failureReason?: string): Promise<RunSummary> => {
		if (shouldRestoreModelSelection) {
			try {
				await options.host.applyStepModelSelection?.(undefined);
			} catch (error) {
				options.host.notify(
					`Failed to restore workflow-start model/thinking: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
		evidence.lastVerification = freshness.lastVerificationWorkspace;
		evidence.workspaceEnd = await captureWorkspaceState(options);
		const summary: RunSummary = {
			runId,
			workflowName: activeWorkflow.name,
			input: options.input,
			state,
			startedAt,
			endedAt: new Date().toISOString(),
			steps,
			loopCounts: { ...loopCounts },
			evidence,
			failureReason,
		};
		checkpoint({
			phase: "run_end",
			finalState: state,
			reason: failureReason,
			workspaceState: evidence.workspaceEnd,
			sessionFiles: evidence.subagentSessions,
		});
		options.host.setStatus(formatStatus({ workflowName: activeWorkflow.name, phase: state === "succeeded" ? "done" : state }));
		options.host.setWidget(formatStepWidget(steps, undefined, undefined, state === "failed" ? failureReason : undefined));
		await options.host.postSummary(summary);
		return summary;
	};

	try {
		throwIfAborted(options.signal);
		options.host.setStatus(formatStatus({ workflowName: activeWorkflow.name, phase: "starting" }));
		options.host.setWidget(formatStepWidget(steps));
		publishRunProgress(options, steps);
		evidence.workspaceStart = await captureWorkspaceState(options);
		checkpoint({ phase: "run_start", workspaceState: evidence.workspaceStart });
		if (resume.error) return finish("failed", resume.error);

		let stepIndex = resume.startIndex;
		while (nextPendingStepIndex(steps) >= 0) {
			throwIfAborted(options.signal);
			if (options.reload) {
				let reloadResult: WorkflowReloadResult;
				try {
					reloadResult = await options.reload();
				} catch {
					reloadResult = { warning: "reload callback failed" };
				}
				if (reloadResult.warning) options.host.notify(`Watch reload skipped: ${sanitizeWatchWarning(reloadResult.warning)}`, "warning");
				if (reloadResult.workflow) {
					activeWorkflow = reloadResult.workflow;
					options.workflow = activeWorkflow;
					definitionRevision = Math.min(definitionRevision + 1, 1_000_000);
					steps = reconcileSteps(activeWorkflow, steps, outputs, feedbackByStep, loopCounts);
					workflowHasModelSelectionOverrides = hasWorkflowModelSelectionOverrides(activeWorkflow);
					publishRunProgress(options, steps, nextPendingStepIndex(steps));
				}
			}
			if (pendingGotoTargetId) {
				const targetIndex = activeWorkflow.steps.findIndex((candidate) => candidate.id === pendingGotoTargetId);
				if (targetIndex < 0) return finish("failed", `goto target "${pendingGotoTargetId}" was removed by watch reload`);
				pendingGotoTargetId = undefined;
			}
			stepIndex = nextPendingStepIndex(steps);
			if (stepIndex < 0) break;
			const step = activeWorkflow.steps[stepIndex]!;
			const stepState = steps[stepIndex]!;
			if (stepState.status === "passed" || stepState.status === "skipped" || stepState.status === "continued") {
				stepIndex += 1;
				continue;
			}
			if (resume.precompletedStepIds?.delete(step.id)) {
				stepIndex += 1;
				continue;
			}
			// A rerun must not expose this step's previous attempt through {outputs.<step-id>}.
			delete outputs[step.id];
			const ctx = makeWorkflowContext(options.input, step, stepIndex, loopCounts, options.cwd, outputs);

			if (step.skipIf && (await step.skipIf(ctx))) {
				stepState.status = "skipped";
				checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, reason: "skipped" });
				updateStepUi(options, steps, stepIndex, "step");
				stepIndex += 1;
				continue;
			}

			stepState.status = "running";
			stepState.checks = [];
			updateStepUi(options, steps, stepIndex, "step");

			if (step.forEach) {
				const items = await resolveForEachItems(options, step, ctx);
				if (!Array.isArray(items)) throw new Error(`forEach items for step "${step.id}" must be an array of strings`);
				if (items.some((item) => typeof item !== "string")) {
					throw new Error(`forEach items for step "${step.id}" must be an array of strings`);
				}
				const maxItems = step.forEach.maxItems ?? 100;
				if (items.length > maxItems) throw new Error(`forEach step "${step.id}" produced ${items.length} items, exceeding maxItems ${maxItems}`);
				if ((step.forEach.concurrency ?? 1) > 1) {
					options.host.notify(
						`forEach step "${step.id}" requested concurrency ${step.forEach.concurrency}; running items sequentially (parallel fan-out is not yet implemented)`,
						"warning",
					);
				}
				if (items.length === 0) {
					options.host.notify(`forEach step "${step.id}" has 0 items`, "info");
					stepState.status = "passed";
					checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, reason: "forEach: 0 items" });
					updateStepUi(options, steps, stepIndex, "step");
					stepIndex += 1;
					continue;
				}

				const failures: string[] = [];
				const digest: string[] = [];
				for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
					const item = items[itemIndex]!;
					updateStepUi(options, steps, stepIndex, "step", undefined, undefined, undefined, itemIndex, items.length);
					let itemResult: ForEachItemResult;
					try {
						itemResult = await executeForEachItem({
							options,
							runId,
							workflowHasModelSelectionOverrides,
							markRestoreModelSelection: () => { shouldRestoreModelSelection = true; },
							step,
							stepIndex,
							stepState,
							steps,
							loopCounts,
							outputs,
							item,
							itemIndex,
							itemCount: items.length,
							feedbackByStep,
							attempts,
							checkpoint,
							evidence,
							freshness,
						});
					} catch (error) {
						stepState.status = "failed";
						updateStepUi(options, steps, stepIndex, "failed", undefined, undefined, undefined, itemIndex, items.length);
						throw error;
					}
					const label = `[${itemIndex + 1}/${items.length}] ${firstLine(item)}`;
					if (itemResult.ok) {
						digest.push(`${label} — ok: ${firstLine(itemResult.summary)}`);
						continue;
					}
					const retrySuffix =
						itemResult.retries > 0 ? ` after ${itemResult.retries} ${itemResult.retries === 1 ? "retry" : "retries"}` : "";
					digest.push(`${label} — FAILED${retrySuffix}: ${itemResult.reason}`);
					failures.push(`forEach step "${step.id}" item ${itemIndex + 1}/${items.length} "${firstLine(item)}" failed${retrySuffix}: ${itemResult.reason}`);
					if (step.forEach.onItemExhausted !== "continue") break;
				}
				outputs[step.id] = truncateStepOutput(digest.join("\n"));
				if (failures.length > 0 && (step.forEach.onItemExhausted !== "continue" || failures.length === items.length)) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					return finish("failed", failures[0]);
				}
				stepState.status = "passed";
				checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, ...stepOutputSnapshot(outputs, step.id) });
				updateStepUi(options, steps, stepIndex, "step");
				stepIndex += 1;
				continue;
			}

			const delegation = resolveStepDelegation(options.workflow, step);
			let observableResult = captureObservableStepResult(undefined);
			let subagentSessionFile: string | undefined;
			if (delegation.mode === "subagent") {
				if (!options.host.runSubagent) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					return finish(
						"failed",
						`step "${step.id}" declares delegation: { subagent: "${delegation.backend}" }, but this host cannot run subagents`,
					);
				}
				const task = await buildSubagentStepTask({
					workflow: options.workflow,
					step,
					ctx,
					stepIndex,
					stepCount: options.workflow.steps.length,
					feedback: feedbackByStep.get(step.id),
				});
				feedbackByStep.delete(step.id);

				checkpoint({ phase: "step_start", stepId: step.id, stepIndex });
				const selection = resolveStepModelSelection(step, getCurrentLoopCount(ctx));
				let result: SubagentStepRunResult;
				try {
					result = await options.host.runSubagent(
						{
							runId,
							workflowName: options.workflow.name,
							stepId: step.id,
							stepTitle: step.title ?? step.id,
							stepIndex,
							stepCount: options.workflow.steps.length,
							backend: delegation.backend,
							task,
							cwd: options.cwd,
							model: selection?.model,
							thinkingLevel: selection?.thinkingLevel,
							timeoutMs: step.subagentTimeoutMs ?? options.workflow.defaults?.subagentTimeoutMs,
						},
						options.signal,
					);
				} catch (error) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					throw infrastructureFailure("Delegated step infrastructure failed.", error, options.signal);
				}
				throwIfAborted(options.signal);
				if (result.errorMessage || result.exitCode !== 0) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					throw delegatedStepFailure(result);
				}
				outputs[step.id] = truncateStepOutput(result.summary);
				observableResult = captureObservableStepResult(result.summary);
				subagentSessionFile = result.sessionFile;
				if (subagentSessionFile && !evidence.subagentSessions.includes(subagentSessionFile)) {
					evidence.subagentSessions.push(subagentSessionFile);
				}
			} else {
				if (workflowHasModelSelectionOverrides) {
					try {
						shouldRestoreModelSelection = true;
						await options.host.applyStepModelSelection?.(resolveStepModelSelection(step, getCurrentLoopCount(ctx)));
					} catch (error) {
						stepState.status = "failed";
						updateStepUi(options, steps, stepIndex, "failed");
						throw error;
					}
				}
				const instruction = await buildStepInstruction({
					workflow: options.workflow,
					step,
					ctx,
					stepIndex,
					stepCount: options.workflow.steps.length,
					feedback: feedbackByStep.get(step.id),
				});
				feedbackByStep.delete(step.id);

				checkpoint({ phase: "step_start", stepId: step.id, stepIndex });
				const capturedOutput = await runMainSessionAttempt(options, step.id, instruction);
				observableResult = captureObservableStepResult(capturedOutput);
				if (capturedOutput !== undefined) outputs[step.id] = truncateStepOutput(capturedOutput);
			}

			const checks = step.checks ?? [];
			if (delegation.mode === "subagent" && checks.length > 0 && workflowHasModelSelectionOverrides) {
				try {
					shouldRestoreModelSelection = true;
					await options.host.applyStepModelSelection?.(resolveStepModelSelection(step, getCurrentLoopCount(ctx)));
				} catch (error) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					throw error;
				}
			}
			let jumpedOrAdvanced = false;
			for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
				throwIfAborted(options.signal);
				const check = checks[checkIndex]!;
				const displayName = check.name ?? check.id ?? `check ${checkIndex + 1}`;
				updateStepUi(options, steps, stepIndex, "check", checkIndex, checks.length, displayName);
				const checkId = makeRuntimeCheckId(runId, step.id, checkIndex, attempts);
				// Step execution may have replaced outputs after the attempt context was created.
				// Snapshot again so each check evaluates only the latest attempt output.
				const checkCtx = makeWorkflowContext(options.input, step, stepIndex, loopCounts, options.cwd, outputs);
				let result: GateResult;
				try {
					result = await executeCheck({
						host: options.host,
						workflow: options.workflow,
						step,
						check,
						ctx: checkCtx,
						checkId,
						runId,
						modelSelection: resolveStepModelSelection(step, getCurrentLoopCount(checkCtx)),
						observableResult,
						signal: options.signal,
					});
				} catch (error) {
					if (check.type !== "agent" || !check.review) throw error;
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					throw infrastructureFailure("Independent review infrastructure failed.", error, options.signal);
				}
				if (result.sessionFile && !evidence.subagentSessions.includes(result.sessionFile)) {
					evidence.subagentSessions.push(result.sessionFile);
				}
				const workspaceState = await captureWorkspaceState(options);
				if (check.type === "deterministic" && result.pass) {
					freshness.lastVerificationWorkspace = workspaceState;
					evidence.lastVerification = workspaceState;
				} else if (check.type === "agent" && result.pass && workspaceChanged(freshness.lastVerificationWorkspace, workspaceState)) {
					result = { ...result, pass: false, reason: "workspace changed after the latest successful deterministic verification" };
				}
				const checkState: CheckRunState = {
					id: checkId,
					name: displayName,
					type: check.type,
					pass: result.pass,
					reason: result.reason,
					command: result.command,
					timeoutMs: result.timeoutMs,
					workspaceState,
				};
				stepState.checks.push(checkState);
				checkpoint({
					phase: "check_result",
					stepId: step.id,
					stepIndex,
					checkId,
					pass: result.pass,
					reason: result.reason,
					checkType: check.type,
					command: result.command,
					timeoutMs: result.timeoutMs,
					sessionFile: result.sessionFile,
					workspaceState,
				});
				if (result.pass && step.outputFrom && checkMatchesOutputFrom(check, step.outputFrom, checkIndex)) {
					outputs[step.id] = truncateStepOutput(result.output ?? "");
				}

				if (result.pass) continue;

				const decision = resolveFailure({
					workflow: options.workflow,
					step,
					check,
					checkIndex,
					result,
					loopCounts,
					steps,
					feedbackByStep,
					host: options.host,
				});

				if (decision.kind === "stop") {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					return finish("failed", decision.reason ?? result.reason);
				}

				if (decision.kind === "continue") {
					stepState.status = "continued";
					checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, reason: decision.reason ?? "continued", ...stepOutputSnapshot(outputs, step.id) });
					stepIndex += 1;
					jumpedOrAdvanced = true;
					break;
				}

				updateStepUi(options, steps, stepIndex, "loop");
				clearOutputsFromStep(options.workflow, outputs, decision.targetIndex!);
				if (decision.targetIndex! <= stepIndex) {
					for (let resetIndex = decision.targetIndex!; resetIndex <= stepIndex; resetIndex += 1) {
						steps[resetIndex]!.status = "pending";
					}
				} else {
					stepState.status = "continued";
					for (let skippedIndex = stepIndex + 1; skippedIndex < decision.targetIndex!; skippedIndex += 1) {
						steps[skippedIndex]!.status = "skipped";
					}
				}
				resume.precompletedStepIds?.delete(options.workflow.steps[decision.targetIndex!]!.id);
				pendingGotoTargetId = decision.targetId;
				jumpedOrAdvanced = true;
				break;
			}

			if (jumpedOrAdvanced) continue;

			stepState.status = "passed";
			checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, sessionFile: subagentSessionFile, ...stepOutputSnapshot(outputs, step.id) });
			updateStepUi(options, steps, stepIndex, "step");
			stepIndex += 1;
		}

		return finish("succeeded");
	} catch (error) {
		if (options.signal?.aborted || isAnvilAbortError(error)) {
			return finish("aborted", "aborted");
		}
		return finish("failed", isWorkflowInfrastructureError(error) ? error.message : error instanceof Error ? error.message : String(error));
	}
}

function reconcileSteps(
	workflow: WorkflowDefinition,
	previous: StepRunState[],
	outputs: Record<string, string>,
	feedbackByStep: Map<string, string>,
	loopCounts: Record<string, number>,
): StepRunState[] {
	const survivingIds = new Set(workflow.steps.map((step) => step.id));
	const priorById = new Map(previous.map((state) => [state.id, state]));
	for (const id of Object.keys(outputs)) if (!survivingIds.has(id)) delete outputs[id];
	for (const id of feedbackByStep.keys()) if (!survivingIds.has(id.split("#", 1)[0]!)) feedbackByStep.delete(id);
	for (const key of Object.keys(loopCounts)) {
		const target = key.includes("->") ? key.slice(key.lastIndexOf("->") + 2) : undefined;
		if (target && !survivingIds.has(target)) delete loopCounts[key];
	}
	return workflow.steps.map((step) => {
		const prior = priorById.get(step.id);
		return prior
			? { ...prior, title: step.title, checks: [...prior.checks] }
			: { id: step.id, title: step.title, status: "pending", loops: 0, checks: [] };
	});
}

function nextPendingStepIndex(steps: StepRunState[]): number {
	return steps.findIndex((step) => step.status === "pending" || step.status === "running");
}

function sanitizeWatchWarning(value: string): string {
	const plain = value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
		.replace(/(?:\/[\w.@+-]+){2,}/g, "[path redacted]")
		.trim();
	return (plain || "candidate could not be loaded or validated").slice(0, 240);
}

function infrastructureFailure(message: string, error: unknown, signal?: AbortSignal): Error {
	throwIfAborted(signal);
	if (isAnvilAbortError(error)) return error;
	if (isWorkflowInfrastructureError(error)) return error;
	return new WorkflowInfrastructureError(`${message} ${sanitizeInfrastructureDiagnostic(error)}`);
}

function delegatedStepFailure(result: SubagentStepRunResult): WorkflowInfrastructureError {
	const exitDetail = `Subagent exited with code ${result.exitCode}.`;
	const diagnostic = result.errorMessage
		? ` ${sanitizeInfrastructureDiagnostic(result.errorMessage)}`
		: " Child output was unavailable.";
	return new WorkflowInfrastructureError(`Delegated step infrastructure failed. ${exitDetail}${diagnostic}`);
}

/** Keeps launch diagnostics actionable without persisting raw child/provider output or secrets. */
function sanitizeInfrastructureDiagnostic(error: unknown): string {
	const value = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const plain = value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
		.replace(/(?:\/[\w.@+-]+){2,}/g, "[path redacted]")
		.trim();
	return `${(plain || "No additional diagnostic was available.").slice(0, 240)}.`.replace(/\.\.+$/, ".");
}

async function captureWorkspaceState(options: RunWorkflowOptions): Promise<WorkspaceState | undefined> {
	try {
		return await options.host.captureWorkspaceState?.(options.cwd, options.signal);
	} catch (error) {
		options.host.notify(`Unable to capture Git workspace state: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return undefined;
	}
}

function workspaceChanged(baseline: WorkspaceState | undefined, current: WorkspaceState | undefined): boolean {
	return baseline !== undefined && current !== undefined && (baseline.head !== current.head || baseline.fingerprint !== current.fingerprint);
}

function resolveResumeState(
	options: RunWorkflowOptions,
	loopCounts: Record<string, number>,
	outputs: Record<string, string>,
	steps: StepRunState[],
): { startIndex: number; error?: string; precompletedStepIds?: Set<string> } {
	if (!options.resume) return { startIndex: 0 };

	const { stepNumber, retryCount = 0 } = options.resume;
	if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > options.workflow.steps.length) {
		return { startIndex: 0, error: `resume step must be an integer from 1 to ${options.workflow.steps.length}` };
	}
	if (!Number.isInteger(retryCount) || retryCount < 0) {
		return { startIndex: 0, error: "resume retry count must be a non-negative integer" };
	}

	const selectedIndex = stepNumber - 1;
	const completedIds = options.resume.completedStepIds === undefined ? undefined : new Set(options.resume.completedStepIds);
	const precompletedStepIds = new Set<string>();
	let startIndex = selectedIndex;
	for (let index = 0; index < selectedIndex; index += 1) {
		const step = options.workflow.steps[index]!;
		if (completedIds === undefined || completedIds.has(step.id)) {
			steps[index]!.status = "skipped";
			precompletedStepIds.add(step.id);
		} else if (startIndex === selectedIndex) {
			startIndex = index;
		}
		if (completedIds?.has(step.id)) {
			const recoveredOutput = options.resume.outputs?.[step.id];
			if (typeof recoveredOutput === "string") outputs[step.id] = truncateStepOutput(recoveredOutput);
		}
	}

	if (retryCount > 0) {
		const step = options.workflow.steps[selectedIndex]!;
		loopCounts[`resume->${step.id}`] = retryCount;
		steps[selectedIndex]!.loops = retryCount;
	}

	return { startIndex, precompletedStepIds };
}

function resolveFailure(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	check: Check;
	checkIndex: number;
	result: GateResult;
	loopCounts: Record<string, number>;
	steps: StepRunState[];
	feedbackByStep: Map<string, string>;
	host: EngineHost;
	/** Set inside a forEach step; scopes loop counts and feedback to the current item. */
	itemIndex?: number;
}): FailureDecision {
	const policy = args.check.onFail ?? args.step.onFail ?? args.workflow.defaults?.onFail ?? "stop";
	if (policy === "stop") return { kind: "stop", reason: args.result.reason };
	if (policy === "continue") return { kind: "continue", reason: args.result.reason };

	const targetIndex = args.workflow.steps.findIndex((step) => step.id === policy.goto);
	if (targetIndex === -1) return { kind: "stop", reason: `goto target "${policy.goto}" does not exist` };

	// Inside a forEach step, retry state is per item so one item's loop budget and feedback
	// never bleed into another. A resume seed applies only to whole-step retries, not items.
	const itemSuffix = args.itemIndex === undefined ? "" : `#${args.itemIndex}`;
	const loopKey = `${args.check.id ?? `${args.step.id}:check${args.checkIndex + 1}`}->${policy.goto}${itemSuffix}`;
	const resumeSeed = args.itemIndex === undefined ? (args.loopCounts[`resume->${policy.goto}`] ?? 0) : 0;
	const nextCount = Math.max(args.loopCounts[loopKey] ?? 0, resumeSeed) + 1;
	args.loopCounts[loopKey] = nextCount;
	const maxLoops = policy.maxLoops ?? args.workflow.defaults?.maxLoops ?? 3;

	if (nextCount > maxLoops) {
		const exhausted = `loop budget exhausted for ${loopKey} (${maxLoops})`;
		const reason = `${exhausted}: ${args.result.reason}`;
		args.host.notify(reason, "warning");
		return { kind: policy.onExhausted === "continue" ? "continue" : "stop", reason };
	}

	args.steps[targetIndex]!.loops += 1;
	const feedbackKey = args.itemIndex === undefined ? policy.goto : `${policy.goto}${itemSuffix}`;
	if (policy.feedback !== false) args.feedbackByStep.set(feedbackKey, args.result.reason);
	args.host.notify(`Anvil check failed; returning to step "${policy.goto}" (${nextCount}/${maxLoops}).`, "warning");
	return { kind: "goto", targetIndex, targetId: policy.goto };
}

async function resolveForEachItems(options: RunWorkflowOptions, step: WorkflowStep, ctx: WorkflowContext): Promise<string[]> {
	const source = step.forEach!.items;
	if (typeof source === "function") return source(ctx);
	const command = await renderCommandTemplatable(source.command, ctx);
	const result = await options.host.exec("bash", ["-c", command], { cwd: ctx.cwd, signal: options.signal });
	if (result.code !== 0) throw new Error(`forEach item command for step "${step.id}" exited ${result.code}: ${result.stderr || result.stdout}`);
	if ((source.parse ?? "lines") === "json") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(`forEach item command for step "${step.id}" did not output valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
			throw new Error(`forEach item command for step "${step.id}" must output a JSON array of strings`);
		}
		return parsed;
	}
	return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

interface ForEachItemArgs {
	options: RunWorkflowOptions;
	runId: string;
	workflowHasModelSelectionOverrides: boolean;
	markRestoreModelSelection: () => void;
	step: WorkflowStep;
	stepIndex: number;
	stepState: StepRunState;
	steps: StepRunState[];
	loopCounts: Record<string, number>;
	outputs: Record<string, string>;
	item: string;
	itemIndex: number;
	itemCount: number;
	feedbackByStep: Map<string, string>;
	attempts: Map<string, number>;
	checkpoint: CheckpointFn;
	evidence: RunEvidence;
	freshness: { lastVerificationWorkspace?: WorkspaceState };
}

type ForEachItemResult = { ok: true; summary: string } | { ok: false; reason: string; retries: number };

/**
 * Runs one forEach item to a terminal outcome, applying the same onFail retry semantics as a
 * normal step but scoped to this item: a `goto` back to the step retries the item with its own
 * feedback, `continue` abandons its remaining checks, and an exhausted loop budget fails the item.
 */
async function executeForEachItem(args: ForEachItemArgs): Promise<ForEachItemResult> {
	const { options, step, stepIndex, itemIndex, itemCount } = args;
	const checks = step.checks ?? [];
	let retries = 0;

	while (true) {
		throwIfAborted(options.signal);
		const ctx = makeWorkflowContext(options.input, step, stepIndex, args.loopCounts, options.cwd, args.outputs, {
			item: args.item,
			itemIndex,
			itemCount,
		});

		const attempt = await runItemDelegation({ ...args, ctx });
		if (!attempt.ok) return { ok: false, reason: attempt.reason, retries };

		const delegation = resolveStepDelegation(options.workflow, step);
		if (delegation.mode === "subagent" && checks.length > 0 && args.workflowHasModelSelectionOverrides) {
			args.markRestoreModelSelection();
			await options.host.applyStepModelSelection?.(resolveStepModelSelection(step, getCurrentLoopCount(ctx)));
		}

		let decision: FailureDecision | undefined;
		for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
			throwIfAborted(options.signal);
			const check = checks[checkIndex]!;
			const displayName = check.name ?? check.id ?? `check ${checkIndex + 1}`;
			updateStepUi(options, args.steps, stepIndex, "check", checkIndex, checks.length, displayName, itemIndex, itemCount);
			const checkId = makeRuntimeCheckId(args.runId, step.id, checkIndex, args.attempts, itemIndex);
			const checkCtx = makeWorkflowContext(
				options.input,
				step,
				stepIndex,
				args.loopCounts,
				options.cwd,
				{ ...args.outputs, [step.id]: truncateStepOutput(attempt.summary) },
				{ item: args.item, itemIndex, itemCount },
			);
			let result: GateResult;
			try {
				result = await executeCheck({
					host: options.host,
					workflow: options.workflow,
					step,
					check,
					ctx: checkCtx,
					checkId,
					runId: args.runId,
					modelSelection: resolveStepModelSelection(step, getCurrentLoopCount(checkCtx)),
					observableResult: captureObservableStepResult(attempt.summary),
					signal: options.signal,
				});
			} catch (error) {
				if (check.type !== "agent" || !check.review) throw error;
				args.stepState.status = "failed";
				updateStepUi(options, args.steps, stepIndex, "failed", undefined, undefined, undefined, itemIndex, itemCount);
				throw infrastructureFailure("Independent review infrastructure failed.", error, options.signal);
			}
			if (result.sessionFile && !args.evidence.subagentSessions.includes(result.sessionFile)) {
				args.evidence.subagentSessions.push(result.sessionFile);
			}
			const workspaceState = await captureWorkspaceState(options);
			if (check.type === "deterministic" && result.pass) {
				args.freshness.lastVerificationWorkspace = workspaceState;
				args.evidence.lastVerification = workspaceState;
			} else if (check.type === "agent" && result.pass && workspaceChanged(args.freshness.lastVerificationWorkspace, workspaceState)) {
				result = { ...result, pass: false, reason: "workspace changed after the latest successful deterministic verification" };
			}
			args.stepState.checks.push({
				id: checkId,
				name: displayName,
				type: check.type,
				pass: result.pass,
				reason: result.reason,
				command: result.command,
				timeoutMs: result.timeoutMs,
				workspaceState,
			});
			args.checkpoint({
				phase: "check_result",
				stepId: step.id,
				stepIndex,
				checkId,
				itemIndex,
				itemCount,
				pass: result.pass,
				reason: result.reason,
				checkType: check.type,
				command: result.command,
				timeoutMs: result.timeoutMs,
				sessionFile: result.sessionFile,
				workspaceState,
			});
			if (result.pass) continue;

			decision = resolveFailure({
				workflow: options.workflow,
				step,
				check,
				checkIndex,
				result,
				loopCounts: args.loopCounts,
				steps: args.steps,
				feedbackByStep: args.feedbackByStep,
				host: options.host,
				itemIndex,
			});
			break;
		}

		if (!decision || decision.kind === "continue") return { ok: true, summary: attempt.summary };
		if (decision.kind === "stop") return { ok: false, reason: decision.reason ?? "", retries };

		// goto self: retry this item with the feedback resolveFailure recorded.
		retries += 1;
		args.stepState.status = "pending";
		updateStepUi(options, args.steps, stepIndex, "loop", undefined, undefined, undefined, itemIndex, itemCount);
	}
}

/** Delegates one forEach item attempt (subagent or main session) and returns its summary. */
async function runItemDelegation(args: ForEachItemArgs & { ctx: WorkflowContext }): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
	const { options, step, stepIndex, ctx, itemIndex, itemCount } = args;
	const feedbackKey = `${step.id}#${itemIndex}`;
	const delegation = resolveStepDelegation(options.workflow, step);

	if (delegation.mode === "subagent") {
		if (!options.host.runSubagent) {
			throw new WorkflowInfrastructureError(
				`Delegated step infrastructure failed. This host cannot run the ${delegation.backend} subagent backend.`,
			);
		}
		const task = await buildSubagentStepTask({
			workflow: options.workflow,
			step,
			ctx,
			stepIndex,
			stepCount: options.workflow.steps.length,
			feedback: args.feedbackByStep.get(feedbackKey),
		});
		args.feedbackByStep.delete(feedbackKey);
		args.checkpoint({ phase: "step_start", stepId: step.id, stepIndex, itemIndex, itemCount });
		const selection = resolveStepModelSelection(step, getCurrentLoopCount(ctx));
		let result: SubagentStepRunResult;
		try {
			result = await options.host.runSubagent(
				{
					runId: args.runId,
					workflowName: options.workflow.name,
					stepId: step.id,
					stepTitle: step.title ?? step.id,
					stepIndex,
					stepCount: options.workflow.steps.length,
					backend: delegation.backend,
					task,
					cwd: options.cwd,
					model: selection?.model,
					thinkingLevel: selection?.thinkingLevel,
					timeoutMs: step.subagentTimeoutMs ?? options.workflow.defaults?.subagentTimeoutMs,
				},
				options.signal,
			);
		} catch (error) {
			throw infrastructureFailure("Delegated step infrastructure failed.", error, options.signal);
		}
		throwIfAborted(options.signal);
		if (result.errorMessage || result.exitCode !== 0) {
			throw delegatedStepFailure(result);
		}
		if (result.sessionFile && !args.evidence.subagentSessions.includes(result.sessionFile)) {
			args.evidence.subagentSessions.push(result.sessionFile);
		}
		return { ok: true, summary: result.summary };
	}

	if (args.workflowHasModelSelectionOverrides) {
		args.markRestoreModelSelection();
		await options.host.applyStepModelSelection?.(resolveStepModelSelection(step, getCurrentLoopCount(ctx)));
	}
	const instruction = await buildStepInstruction({
		workflow: options.workflow,
		step,
		ctx,
		stepIndex,
		stepCount: options.workflow.steps.length,
		feedback: args.feedbackByStep.get(feedbackKey),
	});
	args.feedbackByStep.delete(feedbackKey);
	args.checkpoint({ phase: "step_start", stepId: step.id, stepIndex, itemIndex, itemCount });
	const summary = await runMainSessionAttempt(options, step.id, instruction);
	return { ok: true, summary: summary ?? "" };
}

/** Ends capture in all paths, but only returns captured output after a successful turn. */
async function runMainSessionAttempt(
	options: RunWorkflowOptions,
	stepId: string,
	instruction: string,
): Promise<string | undefined> {
	options.host.beginStepOutputCapture?.(stepId);
	let completed = false;
	let output: string | undefined;
	try {
		options.host.sendInstruction(instruction);
		await options.host.waitForTurnComplete(options.signal);
		throwIfAborted(options.signal);
		completed = true;
	} finally {
		const captured = options.host.endStepOutputCapture?.(stepId);
		if (completed) output = captured;
	}
	return output;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0] ?? "";
}

function hasWorkflowModelSelectionOverrides(workflow: WorkflowDefinition): boolean {
	return workflow.steps.some(
		(step) =>
			step.model !== undefined ||
			step.thinkingLevel !== undefined ||
			(step.retryModelSelections !== undefined && step.retryModelSelections.length > 0),
	);
}

export function resolveStepModelSelection(step: WorkflowStep, retryCount = 0): StepModelSelection | undefined {
	const baseSelection = mergeModelSelection(parseModelReference(step.model), { thinkingLevel: step.thinkingLevel });
	const retrySelection = selectRetryModelSelection(step, retryCount);
	if (!retrySelection) return emptyToUndefined(baseSelection);

	const parsedRetryModel = parseModelReference(retrySelection.model);
	return emptyToUndefined(
		mergeModelSelection(baseSelection, parsedRetryModel, { thinkingLevel: retrySelection.thinkingLevel }),
	);
}

function selectRetryModelSelection(step: WorkflowStep, retryCount: number): StepModelSelection | undefined {
	let selected: (StepModelSelection & { retry: number }) | undefined;
	for (const candidate of step.retryModelSelections ?? []) {
		if (candidate.retry > retryCount) continue;
		if (!selected || candidate.retry > selected.retry) selected = candidate;
	}
	return selected;
}

function mergeModelSelection(...selections: Array<StepModelSelection | undefined>): StepModelSelection {
	const merged: StepModelSelection = {};
	for (const selection of selections) {
		if (!selection) continue;
		if (selection.model !== undefined) merged.model = selection.model;
		if (selection.thinkingLevel !== undefined) merged.thinkingLevel = selection.thinkingLevel;
	}
	return merged;
}

function emptyToUndefined(selection: StepModelSelection): StepModelSelection | undefined {
	return selection.model !== undefined || selection.thinkingLevel !== undefined ? selection : undefined;
}

function parseModelReference(model: string | undefined): StepModelSelection | undefined {
	if (!model) return undefined;
	const lastColon = model.lastIndexOf(":");
	if (lastColon <= 0) return { model };

	const suffix = model.slice(lastColon + 1);
	if (!THINKING_LEVELS.has(suffix as WorkflowThinkingLevel)) return { model };

	const baseModel = model.slice(0, lastColon);
	if (!baseModel) return { model };
	return { model: baseModel, thinkingLevel: suffix as WorkflowThinkingLevel };
}

async function executeCheck(args: {
	host: EngineHost;
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	check: Check;
	ctx: WorkflowContext;
	checkId: string;
	runId: string;
	modelSelection?: StepModelSelection;
	observableResult: ObservableStepResult;
	signal?: AbortSignal;
}): Promise<GateResult> {
	if (args.check.type === "deterministic") {
		return executeDeterministicCheck({
			host: args.host,
			check: args.check,
			ctx: args.ctx,
			checkId: args.checkId,
			signal: args.signal,
		});
	}
	return executeAgentCheck({
		host: args.host,
		workflow: args.workflow,
		step: args.step,
		check: args.check,
		ctx: args.ctx,
		checkId: args.checkId,
		runId: args.runId,
		model: args.modelSelection?.model,
		thinkingLevel: args.modelSelection?.thinkingLevel,
		observableResult: args.observableResult,
		signal: args.signal,
		timeoutMs: args.check.timeoutMs,
	});
}

function publishRunProgress(options: RunWorkflowOptions, steps: StepRunState[], stepIndex?: number): void {
	const activeStep = stepIndex === undefined ? undefined : steps[stepIndex];
	const snapshot: RunProgressSnapshot = Object.freeze({
		workflowName: options.workflow.name,
		steps: Object.freeze(options.workflow.steps.map(({ id, title }) => Object.freeze({ id, title }))),
		...(activeStep ? { stepIndex, retryCount: activeStep.loops } : {}),
	});
	options.host.setRunProgress?.(snapshot);
}

function updateStepUi(
	options: RunWorkflowOptions,
	steps: StepRunState[],
	stepIndex: number,
	phase: "step" | "check" | "loop" | "failed",
	checkIndex?: number,
	checkTotal?: number,
	checkName?: string,
	itemIndex?: number,
	itemCount?: number,
): void {
	const step = steps[stepIndex]!;
	publishRunProgress(options, steps, stepIndex);
	options.host.setStatus(
		formatStatus({
			workflowName: options.workflow.name,
			stepIndex,
			stepTotal: options.workflow.steps.length,
			stepTitle: step.title ?? step.id,
			phase,
			checkIndex,
			checkTotal,
			checkName,
			itemIndex,
			itemCount,
		}),
	);
	const item = itemIndex !== undefined && itemCount !== undefined ? { index: itemIndex, count: itemCount } : undefined;
	options.host.setWidget(formatStepWidget(steps, step.id, item));
}

function makeWorkflowContext(
	input: string,
	step: WorkflowStep,
	stepIndex: number,
	loopCounts: Record<string, number>,
	cwd: string,
	outputs: Record<string, string>,
	item?: Pick<WorkflowContext, "item" | "itemIndex" | "itemCount">,
): WorkflowContext {
	return {
		input,
		step: { id: step.id, index: stepIndex },
		loopCounts: { ...loopCounts },
		cwd,
		outputs: { ...outputs },
		...item,
	};
}

function clearOutputsFromStep(workflow: WorkflowDefinition, outputs: Record<string, string>, targetIndex: number): void {
	for (let index = targetIndex; index < workflow.steps.length; index += 1) delete outputs[workflow.steps[index]!.id];
}

function checkMatchesOutputFrom(check: Check, outputFrom: string, checkIndex: number): boolean {
	return (check.id ?? `check-${checkIndex + 1}`) === outputFrom;
}

function stepOutputSnapshot(outputs: Record<string, string>, stepId: string): { output?: string } {
	return outputs[stepId] === undefined ? {} : { output: outputs[stepId] };
}

function makeRuntimeCheckId(
	runId: string,
	stepId: string,
	checkIndex: number,
	attempts: Map<string, number>,
	itemIndex?: number,
): string {
	const itemPart = itemIndex === undefined ? "" : `:${itemIndex}`;
	const key = `${stepId}${itemPart}:${checkIndex}`;
	const attempt = attempts.get(key) ?? 0;
	attempts.set(key, attempt + 1);
	return `${runId}:${stepId}${itemPart}:${checkIndex}:${attempt}`;
}

export function newRunId(): string {
	return `anvil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export { AnvilAbortError };
