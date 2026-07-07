import type {
	AgentCheck,
	Check,
	DeterministicCheck,
	Templatable,
	WorkflowDefinition,
	WorkflowStep,
	WorkflowThinkingLevel,
} from "./types.ts";

export type ValidationResult =
	| { ok: true; workflow: WorkflowDefinition }
	| { ok: false; errors: string[] };

const WORKFLOW_NAME_RE = /^[a-z0-9-]+$/;
const THINKING_LEVELS = new Set<WorkflowThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const WORKFLOW_KEYS = new Set(["name", "description", "defaults", "steps"]);
const DEFAULTS_KEYS = new Set(["delegation", "subagentTimeoutMs", "agent", "onFail", "maxLoops"]);
const STEP_KEYS = new Set([
	"id",
	"title",
	"prompt",
	"model",
	"thinkingLevel",
	"retryModelSelections",
	"delegation",
	"subagentTimeoutMs",
	"agent",
	"runInMain",
	"skipIf",
	"checks",
	"onFail",
]);
const DETERMINISTIC_CHECK_KEYS = new Set(["type", "id", "name", "command", "cwd", "timeoutMs", "onFail"]);
const AGENT_CHECK_KEYS = new Set(["type", "id", "name", "prompt", "agent", "onFail"]);
const CHECK_KEYS = new Set([...DETERMINISTIC_CHECK_KEYS, ...AGENT_CHECK_KEYS]);
const ON_FAIL_KEYS = new Set(["goto", "maxLoops", "onExhausted", "feedback"]);
const RETRY_MODEL_SELECTION_KEYS = new Set(["retry", "model", "thinkingLevel"]);

export function validateWorkflow(value: unknown): ValidationResult {
	const errors: string[] = [];

	if (!isRecord(value)) {
		return { ok: false, errors: ["workflow must be an object"] };
	}

	validateKnownKeys(value, "workflow", WORKFLOW_KEYS, errors);

	if (typeof value.name !== "string" || value.name.length === 0) {
		errors.push("workflow.name must be a non-empty string");
	} else if (!WORKFLOW_NAME_RE.test(value.name)) {
		errors.push("workflow.name must match /^[a-z0-9-]+$/");
	}

	if (value.description !== undefined && typeof value.description !== "string") {
		errors.push("workflow.description must be a string when provided");
	}

	const rawSteps = value.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		if (value.defaults !== undefined) validateDefaults(value.defaults, errors);
		errors.push("workflow.steps must be a non-empty array");
		return errors.length === 0
			? { ok: true, workflow: value as unknown as WorkflowDefinition }
			: { ok: false, errors };
	}

	const stepIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const step of rawSteps) {
		if (isRecord(step) && typeof step.id === "string" && step.id.length > 0) {
			if (stepIds.has(step.id)) duplicateIds.add(step.id);
			stepIds.add(step.id);
		}
	}
	for (const id of duplicateIds) errors.push(`duplicate step id "${id}"`);

	if (value.defaults !== undefined) validateDefaults(value.defaults, errors, stepIds);
	rawSteps.forEach((step, index) => validateStep(step, index, stepIds, errors));

	return errors.length === 0
		? { ok: true, workflow: value as unknown as WorkflowDefinition }
		: { ok: false, errors };
}

function validateDefaults(defaults: unknown, errors: string[], stepIds?: Set<string>): void {
	if (!isRecord(defaults)) {
		errors.push("workflow.defaults must be an object when provided");
		return;
	}
	validateKnownKeys(defaults, "workflow.defaults", DEFAULTS_KEYS, errors);
	if (defaults.delegation !== undefined) {
		validateDelegation(defaults.delegation, "workflow.defaults.delegation", errors);
	}
	if (defaults.agent !== undefined && typeof defaults.agent !== "string") {
		errors.push("workflow.defaults.agent must be a string when provided");
	}
	if (defaults.maxLoops !== undefined && !isNonNegativeInteger(defaults.maxLoops)) {
		errors.push("workflow.defaults.maxLoops must be a non-negative integer when provided");
	}
	if (defaults.subagentTimeoutMs !== undefined && !isPositiveInteger(defaults.subagentTimeoutMs)) {
		errors.push("workflow.defaults.subagentTimeoutMs must be a positive integer when provided");
	}
	if (defaults.onFail !== undefined) {
		validateOnFailPolicy(defaults.onFail, "workflow.defaults.onFail", stepIds, errors);
	}
}

function validateStep(step: unknown, index: number, stepIds: Set<string>, errors: string[]): void {
	const path = `workflow.steps[${index}]`;
	if (!isRecord(step)) {
		errors.push(`${path} must be an object`);
		return;
	}

	validateKnownKeys(step, path, STEP_KEYS, errors);

	if (typeof step.id !== "string" || step.id.length === 0) {
		errors.push(`${path}.id must be a non-empty string`);
	}
	if (step.title !== undefined && typeof step.title !== "string") {
		errors.push(`${path}.title must be a string when provided`);
	}
	if (!isTemplatable(step.prompt)) {
		errors.push(`${path}.prompt must be a string or function`);
	}
	if (step.model !== undefined && (typeof step.model !== "string" || step.model.length === 0)) {
		errors.push(`${path}.model must be a non-empty string when provided`);
	}
	if (step.thinkingLevel !== undefined && !isThinkingLevel(step.thinkingLevel)) {
		errors.push(
			`${path}.thinkingLevel must be one of "off", "minimal", "low", "medium", "high", or "xhigh" when provided`,
		);
	}
	if (step.retryModelSelections !== undefined) {
		validateRetryModelSelections(step.retryModelSelections, `${path}.retryModelSelections`, errors);
	}
	if (step.delegation !== undefined) {
		validateDelegation(step.delegation, `${path}.delegation`, errors);
	}
	if (step.subagentTimeoutMs !== undefined && !isPositiveInteger(step.subagentTimeoutMs)) {
		errors.push(`${path}.subagentTimeoutMs must be a positive integer when provided`);
	}
	if (step.agent !== undefined && typeof step.agent !== "string") {
		errors.push(`${path}.agent must be a string when provided`);
	}
	if (step.runInMain !== undefined && typeof step.runInMain !== "boolean") {
		errors.push(`${path}.runInMain must be a boolean when provided`);
	}
	if (step.skipIf !== undefined && typeof step.skipIf !== "function") {
		errors.push(`${path}.skipIf must be a function when provided`);
	}
	if (step.onFail !== undefined) {
		validateOnFailPolicy(step.onFail, `${path}.onFail`, stepIds, errors);
	}

	if (step.checks !== undefined) {
		if (!Array.isArray(step.checks)) {
			errors.push(`${path}.checks must be an array when provided`);
		} else {
			step.checks.forEach((check, checkIndex) =>
				validateCheck(check, `${path}.checks[${checkIndex}]`, stepIds, errors),
			);
		}
	}
}

function validateRetryModelSelections(selections: unknown, path: string, errors: string[]): void {
	if (!Array.isArray(selections)) {
		errors.push(`${path} must be an array when provided`);
		return;
	}

	const seenRetries = new Set<number>();
	const duplicateRetries = new Set<number>();
	selections.forEach((selection, index) => {
		const selectionPath = `${path}[${index}]`;
		if (!isRecord(selection)) {
			errors.push(`${selectionPath} must be an object`);
			return;
		}

		validateKnownKeys(selection, selectionPath, RETRY_MODEL_SELECTION_KEYS, errors);
		if (!isNonNegativeInteger(selection.retry)) {
			errors.push(`${selectionPath}.retry must be a non-negative integer`);
		} else {
			const retry = selection.retry as number;
			if (seenRetries.has(retry)) duplicateRetries.add(retry);
			seenRetries.add(retry);
		}
		if (selection.model !== undefined && (typeof selection.model !== "string" || selection.model.length === 0)) {
			errors.push(`${selectionPath}.model must be a non-empty string when provided`);
		}
		if (selection.thinkingLevel !== undefined && !isThinkingLevel(selection.thinkingLevel)) {
			errors.push(
				`${selectionPath}.thinkingLevel must be one of "off", "minimal", "low", "medium", "high", or "xhigh" when provided`,
			);
		}
		if (selection.model === undefined && selection.thinkingLevel === undefined) {
			errors.push(`${selectionPath} must provide model or thinkingLevel`);
		}
	});

	for (const retry of duplicateRetries) errors.push(`${path} duplicate retry value ${retry}`);
}

function validateCheck(check: unknown, path: string, stepIds: Set<string>, errors: string[]): void {
	if (!isRecord(check)) {
		errors.push(`${path} must be an object`);
		return;
	}

	if (check.id !== undefined && (typeof check.id !== "string" || check.id.length === 0)) {
		errors.push(`${path}.id must be a non-empty string when provided`);
	}
	if (check.name !== undefined && typeof check.name !== "string") {
		errors.push(`${path}.name must be a string when provided`);
	}
	if (check.onFail !== undefined) {
		validateOnFailPolicy(check.onFail, `${path}.onFail`, stepIds, errors);
	}

	if (check.type === "deterministic") {
		validateKnownKeys(check, path, DETERMINISTIC_CHECK_KEYS, errors);
		validateDeterministicCheck(check as Record<string, unknown>, path, errors);
		return;
	}
	if (check.type === "agent") {
		validateKnownKeys(check, path, AGENT_CHECK_KEYS, errors);
		validateAgentCheck(check as Record<string, unknown>, path, errors);
		return;
	}
	validateKnownKeys(check, path, CHECK_KEYS, errors);
	errors.push(`${path}.type must be "deterministic" or "agent"`);
}

function validateDeterministicCheck(check: Record<string, unknown>, path: string, errors: string[]): void {
	const typed = check as unknown as DeterministicCheck;
	if (!isTemplatable(typed.command)) {
		errors.push(`${path}.command must be a string or function`);
	}
	if (check.cwd !== undefined && typeof check.cwd !== "string") {
		errors.push(`${path}.cwd must be a string when provided`);
	}
	if (check.timeoutMs !== undefined && !isPositiveInteger(check.timeoutMs)) {
		errors.push(`${path}.timeoutMs must be a positive integer when provided`);
	}
}

function validateAgentCheck(check: Record<string, unknown>, path: string, errors: string[]): void {
	const typed = check as unknown as AgentCheck;
	if (!isTemplatable(typed.prompt)) {
		errors.push(`${path}.prompt must be a string or function`);
	}
	if (check.agent !== undefined && typeof check.agent !== "string") {
		errors.push(`${path}.agent must be a string when provided`);
	}
}

function validateDelegation(delegation: unknown, path: string, errors: string[]): void {
	if (delegation === "auto" || delegation === "none") return;
	if (!isRecord(delegation)) {
		errors.push(`${path} must be "auto", "none", { skill: string }, or { subagent: "cmux" | "herdr" }`);
		return;
	}
	if ("subagent" in delegation) {
		if (delegation.subagent !== "cmux" && delegation.subagent !== "herdr") {
			errors.push(`${path}.subagent must be "cmux" or "herdr"`);
		}
		return;
	}
	if (typeof delegation.skill !== "string" || delegation.skill.length === 0) {
		errors.push(`${path}.skill must be a non-empty string`);
	}
}

function validateOnFailPolicy(
	policy: unknown,
	path: string,
	stepIds: Set<string> | undefined,
	errors: string[],
): void {
	if (policy === "stop" || policy === "continue") return;
	if (!isRecord(policy)) {
		errors.push(`${path} must be "stop", "continue", or a goto object`);
		return;
	}

	validateKnownKeys(policy, path, ON_FAIL_KEYS, errors);
	const goto = policy.goto;
	if (typeof goto !== "string" || goto.length === 0) {
		errors.push(`${path}.goto must be a non-empty string`);
	} else if (stepIds && !stepIds.has(goto)) {
		errors.push(`${path}.goto target "${goto}" does not exist`);
	}
	if (policy.maxLoops !== undefined && !isNonNegativeInteger(policy.maxLoops)) {
		errors.push(`${path}.maxLoops must be a non-negative integer when provided`);
	}
	if (
		policy.onExhausted !== undefined &&
		policy.onExhausted !== "stop" &&
		policy.onExhausted !== "continue"
	) {
		errors.push(`${path}.onExhausted must be "stop" or "continue" when provided`);
	}
	if (policy.feedback !== undefined && typeof policy.feedback !== "boolean") {
		errors.push(`${path}.feedback must be a boolean when provided`);
	}
}

function validateKnownKeys(record: Record<string, unknown>, path: string, allowed: Set<string>, errors: string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) errors.push(`${path}.${key} is not recognized`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTemplatable(value: unknown): value is Templatable {
	return typeof value === "string" || typeof value === "function";
}

function isThinkingLevel(value: unknown): value is WorkflowThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as WorkflowThinkingLevel);
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
	return Number.isInteger(value) && (value as number) >= 0;
}

export function getWorkflowNameCandidate(value: unknown, fallback: string): string {
	return isRecord(value) && typeof value.name === "string" && value.name.length > 0 ? value.name : fallback;
}
