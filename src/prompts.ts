import type { AgentCheck, WorkflowContext, WorkflowDefinition, WorkflowStep, Templatable, WorkflowDelegation } from "./types.ts";

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

export function renderTemplateString(template: string, ctx: WorkflowContext): string {
	return template.replaceAll("{input}", ctx.input).replaceAll("{loop}", String(getCurrentLoopCount(ctx)));
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
	| { mode: "skill"; skill: string };

export function resolveStepDelegation(workflow: WorkflowDefinition, step: WorkflowStep): ResolvedStepDelegation {
	if (step.runInMain) return { mode: "none" };

	const configured = step.delegation ?? workflow.defaults?.delegation;
	const resolved = resolveConfiguredDelegation(configured);
	if (resolved) return resolved;

	const legacyHint = step.agent ?? workflow.defaults?.agent;
	return legacyHint ? { mode: "auto", hint: legacyHint } : { mode: "none" };
}

function resolveConfiguredDelegation(delegation: WorkflowDelegation | undefined): ResolvedStepDelegation | undefined {
	if (!delegation) return undefined;
	if (delegation === "auto") return { mode: "auto" };
	if (delegation === "none") return { mode: "none" };
	return { mode: "skill", skill: delegation.skill };
}

export function getCurrentLoopCount(ctx: WorkflowContext): number {
	let count = 0;
	const suffix = `->${ctx.step.id}`;
	for (const [key, value] of Object.entries(ctx.loopCounts)) {
		if (key.endsWith(suffix) && value > count) count = value;
	}
	return count;
}
