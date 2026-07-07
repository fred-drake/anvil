import { shellEscape } from "./shell.ts";
import type {
	AgentCheck,
	Templatable,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowDelegation,
	WorkflowStep,
	WorkflowSubagentBackend,
} from "./types.ts";

export interface StepInstructionOptions {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	ctx: WorkflowContext;
	stepIndex: number;
	stepCount: number;
	feedback?: string;
}

export async function renderTemplatable(template: Templatable, ctx: WorkflowContext): Promise<string> {
	if (typeof template === "function") return template(ctx);
	return renderTemplateString(template, ctx);
}

export async function renderCommandTemplatable(template: Templatable, ctx: WorkflowContext): Promise<string> {
	if (typeof template === "function") return template(ctx);
	return renderCommandTemplateString(template, ctx);
}

export function renderTemplateString(template: string, ctx: WorkflowContext): string {
	return replaceTemplatePlaceholders(template, ctx, (value) => value);
}

export function renderCommandTemplateString(template: string, ctx: WorkflowContext): string {
	return renderCommandPlaceholders(template, [
		{ token: "{input}", variable: "__ANVIL_INPUT", value: ctx.input },
		{ token: "{loop}", variable: "__ANVIL_LOOP", value: String(getCurrentLoopCount(ctx)) },
	]);
}

function replaceTemplatePlaceholders(
	template: string,
	ctx: WorkflowContext,
	escapeValue: (value: string) => string,
): string {
	return template
		.replaceAll("{input}", escapeValue(ctx.input))
		.replaceAll("{loop}", escapeValue(String(getCurrentLoopCount(ctx))));
}

type ShellQuote = "single" | "double" | undefined;

interface CommandPlaceholder {
	token: string;
	variable: string;
	value: string;
}

function renderCommandPlaceholders(template: string, placeholders: CommandPlaceholder[]): string {
	let rendered = "";
	let quote: ShellQuote;
	let usedPlaceholder = false;

	for (let index = 0; index < template.length;) {
		const placeholder = placeholders.find((candidate) => template.startsWith(candidate.token, index));
		if (placeholder) {
			rendered += commandPlaceholderExpansion(placeholder.variable, quote);
			index += placeholder.token.length;
			usedPlaceholder = true;
			continue;
		}

		const char = template[index]!;
		if (char === "\\" && quote !== "single" && index + 1 < template.length) {
			rendered += template.slice(index, index + 2);
			index += 2;
			continue;
		}

		rendered += char;
		if (quote === "single") {
			if (char === "'") quote = undefined;
		} else if (quote === "double") {
			if (char === '"') quote = undefined;
		} else if (char === "'") {
			quote = "single";
		} else if (char === '"') {
			quote = "double";
		}
		index += 1;
	}

	if (!usedPlaceholder) return template;

	const assignments = placeholders
		.map((placeholder) => `${placeholder.variable}=${shellEscape(placeholder.value)}`)
		.join(" ");
	return `${assignments}; ${rendered}`;
}

function commandPlaceholderExpansion(variable: string, quote: ShellQuote): string {
	const parameterExpansion = `\${${variable}}`;
	if (quote === "single") return `'"${parameterExpansion}"'`;
	if (quote === "double") return parameterExpansion;
	return `"${parameterExpansion}"`;
}

export async function buildStepInstruction(options: StepInstructionOptions): Promise<string> {
	const renderedPrompt = await renderTemplatable(options.step.prompt, options.ctx);
	const task = appendFeedback(renderedPrompt, options.feedback);
	const title = options.step.title ?? options.step.id;
	const header = `[anvil] Workflow "${options.workflow.name}" — step ${options.stepIndex + 1}/${options.stepCount}: ${title}`;

	const delegation = resolveStepDelegation(options.workflow, options.step);
	if (delegation.mode === "skill") {
		return (
			`${header}\n\n` +
			`Delegate this workflow step to a subagent using skill "${delegation.skill}" if a delegation capability is available. ` +
			`If no delegation capability is available, do the work directly in the main agent using that skill.\n\n` +
			`Task:\n${task}`
		);
	}
	if (delegation.mode === "auto") {
		const hint = delegation.hint ? ` Prefer agent/skill "${delegation.hint}" if appropriate.` : "";
		return (
			`${header}\n\n` +
			`Choose whether to use a subagent for this workflow step.${hint} ` +
			`If a suitable delegation capability is available, delegate to the best agent or skill; otherwise do the work directly in the main agent.\n\n` +
			`Task:\n${task}`
		);
	}

	return `${header}\n\nDo this workflow step directly in the main agent. Do not delegate to a subagent.\n\n${task}`;
}

/** Task prompt for a step Anvil runs itself in a dedicated subagent session. */
export async function buildSubagentStepTask(options: StepInstructionOptions): Promise<string> {
	const renderedPrompt = await renderTemplatable(options.step.prompt, options.ctx);
	const task = appendFeedback(renderedPrompt, options.feedback);
	const title = options.step.title ?? options.step.id;
	const header = `[anvil] Workflow "${options.workflow.name}" — step ${options.stepIndex + 1}/${options.stepCount}: ${title}`;

	return (
		`${header}\n\n` +
		`You are a subagent session executing this workflow step. Complete the task autonomously, without asking for confirmation. ` +
		`Your final message is reported back to the main workflow session as this step's outcome, so end with a concise summary of what you did.\n\n` +
		`Task:\n${task}`
	);
}

export function buildSubagentResultMessage(args: {
	workflowName: string;
	stepTitle: string;
	stepIndex: number;
	stepCount: number;
	backend: WorkflowSubagentBackend;
	summary: string;
	sessionFile?: string;
}): string {
	const sessionLine = args.sessionFile ? `\n\nSubagent session: ${args.sessionFile}` : "";
	return (
		`[anvil] Workflow "${args.workflowName}" — step ${args.stepIndex + 1}/${args.stepCount} "${args.stepTitle}" ` +
		`was executed by a ${args.backend} subagent session. Treat the summary below as this step's outcome; do not redo the work.\n\n` +
		`Subagent summary:\n${args.summary}${sessionLine}`
	);
}

export async function buildAgentCheckInstruction(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	check: AgentCheck;
	ctx: WorkflowContext;
	checkId: string;
}): Promise<string> {
	const criteria = await renderTemplatable(args.check.prompt, args.ctx);
	const delegateLine = args.check.agent
		? `\nIf you use subagents for evaluations, delegate this evaluation to subagent "${args.check.agent}".`
		: "";

	return `[anvil] Workflow "${args.workflow.name}" — evaluate step "${args.step.id}".\n\n` +
		`Evaluation criteria:\n${criteria}${delegateLine}\n\n` +
		`Call the \`anvil_verdict\` tool exactly once with:\n` +
		`- check_id: ${args.checkId}\n` +
		`- pass: true if the criteria are satisfied, otherwise false\n` +
		`- reason: a concise explanation\n\n` +
		`Do not report the verdict only in prose; the workflow engine only accepts the tool call.`;
}

export function buildVerdictReprompt(checkId: string): string {
	return `[anvil] You did not report a verdict for check_id ${checkId}. Call the \`anvil_verdict\` tool now exactly once with check_id ${checkId}, pass, and reason.`;
}

export function appendFeedback(prompt: string, feedback?: string): string {
	if (!feedback?.trim()) return prompt;
	return `${prompt}\n\n## Feedback from failed check\n${feedback.trim()}`;
}

export type ResolvedStepDelegation =
	| { mode: "none" }
	| { mode: "auto"; hint?: string }
	| { mode: "skill"; skill: string }
	| { mode: "subagent"; backend: WorkflowSubagentBackend };

export function resolveStepDelegation(workflow: WorkflowDefinition, step: WorkflowStep): ResolvedStepDelegation {
	if (step.runInMain) return { mode: "none" };

	const legacyHint = step.agent ?? workflow.defaults?.agent;
	const configured = step.delegation ?? workflow.defaults?.delegation;
	if (configured) return resolveConfiguredDelegation(configured, legacyHint);

	return resolveAutoDelegation(legacyHint);
}

function resolveConfiguredDelegation(delegation: WorkflowDelegation, legacyHint?: string): ResolvedStepDelegation {
	if (delegation === "auto") return resolveAutoDelegation(legacyHint);
	if (delegation === "none") return { mode: "none" };
	if ("subagent" in delegation) return { mode: "subagent", backend: delegation.subagent };
	return { mode: "skill", skill: delegation.skill };
}

function resolveAutoDelegation(hint?: string): ResolvedStepDelegation {
	const backend = detectAutoSubagentBackend();
	return backend ? { mode: "subagent", backend } : hint ? { mode: "auto", hint } : { mode: "auto" };
}

export function detectAutoSubagentBackend(): WorkflowSubagentBackend | undefined {
	if (process.env.HERDR_ENV === "1") return "herdr";
	if (process.env.CMUX_SHELL_INTEGRATION === "1") return "cmux";
	return undefined;
}

export function workflowSubagentBackends(workflow: WorkflowDefinition): WorkflowSubagentBackend[] {
	const backends = new Set<WorkflowSubagentBackend>();
	for (const step of workflow.steps) {
		const delegation = resolveStepDelegation(workflow, step);
		if (delegation.mode === "subagent") backends.add(delegation.backend);
	}
	return [...backends];
}

export function workflowUsesSubagentDelegation(workflow: WorkflowDefinition): boolean {
	return workflowSubagentBackends(workflow).length > 0;
}

export function getCurrentLoopCount(ctx: WorkflowContext): number {
	let count = 0;
	const suffix = `->${ctx.step.id}`;
	for (const [key, value] of Object.entries(ctx.loopCounts)) {
		if (key.endsWith(suffix) && value > count) count = value;
	}
	return count;
}
