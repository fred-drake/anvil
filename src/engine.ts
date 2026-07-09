import { AnvilAbortError, isAnvilAbortError, throwIfAborted } from "./errors.ts";
import { executeAgentCheck, executeDeterministicCheck, type GateResult, type Verdict } from "./gates.ts";
import { buildStepInstruction, buildSubagentStepTask, getCurrentLoopCount, resolveStepDelegation } from "./prompts.ts";
import type {
	Check,
	OnFailPolicy,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowStep,
	WorkflowSubagentBackend,
	WorkflowThinkingLevel,
} from "./types.ts";
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
const MAX_STEP_OUTPUT_CHARS = 8 * 1024;

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

export interface EngineHost {
	applyStepModelSelection?(selection: StepModelSelection | undefined): void | Promise<void>;
	/** Run a subagent-delegated step to completion. Required for workflows using delegation: { subagent }. */
	runSubagent?(request: SubagentStepRunRequest, signal?: AbortSignal): Promise<SubagentStepRunResult>;
	sendInstruction(instruction: string): void;
	waitForTurnComplete(signal?: AbortSignal): Promise<void>;
	exec(command: string, args: string[], options?: EngineExecOptions): Promise<EngineExecResult>;
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
	/** One-based workflow step number to resume from. */
	stepNumber: number;
	/** Current retry/loop count for the resumed step. Defaults to 0. */
	retryCount?: number;
}

export interface RunWorkflowOptions {
	workflow: WorkflowDefinition;
	input: string;
	cwd: string;
	host: EngineHost;
	runId?: string;
	resume?: ResumeWorkflowOptions;
	signal?: AbortSignal;
}

export type StepRunStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "continued";

export interface CheckRunState {
	id: string;
	name: string;
	pass: boolean;
	reason: string;
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
	stepId?: string;
	stepIndex?: number;
	checkId?: string;
	pass?: boolean;
	reason?: string;
	loopCounts?: Record<string, number>;
	finalState?: RunSummary["state"];
}

interface FailureDecision {
	kind: "stop" | "continue" | "goto";
	reason?: string;
	targetIndex?: number;
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<RunSummary> {
	const runId = options.runId ?? newRunId();
	const startedAt = new Date().toISOString();
	const loopCounts: Record<string, number> = {};
	const outputs: Record<string, string> = {};
	const feedbackByStep = new Map<string, string>();
	const attempts = new Map<string, number>();
	const workflowHasModelSelectionOverrides = hasWorkflowModelSelectionOverrides(options.workflow);
	let shouldRestoreModelSelection = false;
	const steps = options.workflow.steps.map<StepRunState>((step) => ({
		id: step.id,
		title: step.title,
		status: "pending",
		loops: 0,
		checks: [],
	}));
	const resume = resolveResumeState(options, loopCounts, steps);

	const checkpoint = (entry: Omit<AnvilCheckpoint, "runId" | "workflowName" | "input" | "timestamp">) => {
		options.host.checkpoint({
			runId,
			workflowName: options.workflow.name,
			input: options.input,
			timestamp: new Date().toISOString(),
			loopCounts: { ...loopCounts },
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
		const summary: RunSummary = {
			runId,
			workflowName: options.workflow.name,
			input: options.input,
			state,
			startedAt,
			endedAt: new Date().toISOString(),
			steps,
			loopCounts: { ...loopCounts },
			failureReason,
		};
		checkpoint({ phase: "run_end", finalState: state, reason: failureReason });
		options.host.setStatus(formatStatus({ workflowName: options.workflow.name, phase: state === "succeeded" ? "done" : state }));
		options.host.setWidget(formatStepWidget(steps));
		await options.host.postSummary(summary);
		return summary;
	};

	try {
		throwIfAborted(options.signal);
		options.host.setStatus(formatStatus({ workflowName: options.workflow.name, phase: "starting" }));
		options.host.setWidget(formatStepWidget(steps));
		checkpoint({ phase: "run_start" });
		if (resume.error) return finish("failed", resume.error);

		let stepIndex = resume.startIndex;
		while (stepIndex < options.workflow.steps.length) {
			throwIfAborted(options.signal);
			const step = options.workflow.steps[stepIndex]!;
			const stepState = steps[stepIndex]!;
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
			const delegation = resolveStepDelegation(options.workflow, step);
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
					throw error;
				}
				throwIfAborted(options.signal);
				if (result.errorMessage || result.exitCode !== 0) {
					stepState.status = "failed";
					updateStepUi(options, steps, stepIndex, "failed");
					return finish(
						"failed",
						result.errorMessage ?? `subagent for step "${step.id}" exited with code ${result.exitCode}`,
					);
				}
				outputs[step.id] = truncateStepOutput(result.summary);
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
				options.host.beginStepOutputCapture?.(step.id);
				options.host.sendInstruction(instruction);
				await options.host.waitForTurnComplete(options.signal);
				const capturedOutput = options.host.endStepOutputCapture?.(step.id);
				if (capturedOutput !== undefined) outputs[step.id] = truncateStepOutput(capturedOutput);
				throwIfAborted(options.signal);
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
				const result = await executeCheck({
					host: options.host,
					workflow: options.workflow,
					step,
					check,
					ctx,
					checkId,
					signal: options.signal,
				});
				const checkState: CheckRunState = {
					id: checkId,
					name: displayName,
					pass: result.pass,
					reason: result.reason,
				};
				stepState.checks.push(checkState);
				checkpoint({
					phase: "check_result",
					stepId: step.id,
					stepIndex,
					checkId,
					pass: result.pass,
					reason: result.reason,
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
					checkpoint({ phase: "step_pass", stepId: step.id, stepIndex, reason: decision.reason ?? "continued" });
					stepIndex += 1;
					jumpedOrAdvanced = true;
					break;
				}

				stepState.status = "pending";
				updateStepUi(options, steps, stepIndex, "loop");
				stepIndex = decision.targetIndex!;
				jumpedOrAdvanced = true;
				break;
			}

			if (jumpedOrAdvanced) continue;

			stepState.status = "passed";
			checkpoint({ phase: "step_pass", stepId: step.id, stepIndex });
			updateStepUi(options, steps, stepIndex, "step");
			stepIndex += 1;
		}

		return finish("succeeded");
	} catch (error) {
		if (options.signal?.aborted || isAnvilAbortError(error)) {
			return finish("aborted", "aborted");
		}
		return finish("failed", error instanceof Error ? error.message : String(error));
	}
}

function resolveResumeState(
	options: RunWorkflowOptions,
	loopCounts: Record<string, number>,
	steps: StepRunState[],
): { startIndex: number; error?: string } {
	if (!options.resume) return { startIndex: 0 };

	const { stepNumber, retryCount = 0 } = options.resume;
	if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > options.workflow.steps.length) {
		return { startIndex: 0, error: `resume step must be an integer from 1 to ${options.workflow.steps.length}` };
	}
	if (!Number.isInteger(retryCount) || retryCount < 0) {
		return { startIndex: 0, error: "resume retry count must be a non-negative integer" };
	}

	const startIndex = stepNumber - 1;
	for (let index = 0; index < startIndex; index += 1) steps[index]!.status = "skipped";

	if (retryCount > 0) {
		const step = options.workflow.steps[startIndex]!;
		loopCounts[`resume->${step.id}`] = retryCount;
		steps[startIndex]!.loops = retryCount;
	}

	return { startIndex };
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
}): FailureDecision {
	const policy = args.check.onFail ?? args.step.onFail ?? args.workflow.defaults?.onFail ?? "stop";
	if (policy === "stop") return { kind: "stop", reason: args.result.reason };
	if (policy === "continue") return { kind: "continue", reason: args.result.reason };

	const targetIndex = args.workflow.steps.findIndex((step) => step.id === policy.goto);
	if (targetIndex === -1) return { kind: "stop", reason: `goto target "${policy.goto}" does not exist` };

	const loopKey = `${args.check.id ?? `${args.step.id}:check${args.checkIndex + 1}`}->${policy.goto}`;
	const resumeSeed = args.loopCounts[`resume->${policy.goto}`] ?? 0;
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
	if (policy.feedback !== false) args.feedbackByStep.set(policy.goto, args.result.reason);
	args.host.notify(`Anvil check failed; returning to step "${policy.goto}" (${nextCount}/${maxLoops}).`, "warning");
	return { kind: "goto", targetIndex };
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
		signal: args.signal,
		timeoutMs: args.check.timeoutMs,
	});
}

function updateStepUi(
	options: RunWorkflowOptions,
	steps: StepRunState[],
	stepIndex: number,
	phase: "step" | "check" | "loop" | "failed",
	checkIndex?: number,
	checkTotal?: number,
	checkName?: string,
): void {
	const step = steps[stepIndex]!;
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
		}),
	);
	options.host.setWidget(formatStepWidget(steps, step.id));
}

function makeWorkflowContext(
	input: string,
	step: WorkflowStep,
	stepIndex: number,
	loopCounts: Record<string, number>,
	cwd: string,
	outputs: Record<string, string>,
): WorkflowContext {
	return {
		input,
		step: { id: step.id, index: stepIndex },
		loopCounts: { ...loopCounts },
		cwd,
		outputs: { ...outputs },
	};
}

function checkMatchesOutputFrom(check: Check, outputFrom: string, checkIndex: number): boolean {
	return (check.id ?? `check-${checkIndex + 1}`) === outputFrom;
}

function truncateStepOutput(output: string): string {
	return output.length <= MAX_STEP_OUTPUT_CHARS ? output : output.slice(-MAX_STEP_OUTPUT_CHARS);
}

function makeRuntimeCheckId(runId: string, stepId: string, checkIndex: number, attempts: Map<string, number>): string {
	const key = `${stepId}:${checkIndex}`;
	const attempt = attempts.get(key) ?? 0;
	attempts.set(key, attempt + 1);
	return `${runId}:${stepId}:${checkIndex}:${attempt}`;
}

export function newRunId(): string {
	return `anvil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export { AnvilAbortError };
