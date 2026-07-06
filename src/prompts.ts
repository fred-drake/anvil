import type { SubagentToolConfig } from "./config.ts";
import type { AgentCheck, WorkflowContext, WorkflowDefinition, WorkflowStep, Templatable } from "./types.ts";

export interface StepInstructionOptions {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	ctx: WorkflowContext;
	stepIndex: number;
	stepCount: number;
	feedback?: string;
	subagent?: SubagentToolConfig;
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

	if (options.subagent) {
		const agent = options.step.agent ?? options.workflow.defaults?.agent ?? "default";
		const delegated = renderInstructionTemplate(options.subagent.instructionTemplate, {
			tool: options.subagent.toolName,
			agent,
			task,
		});
		return `${header}\n\n${delegated}\n\nDo not do the work yourself; delegate through the configured tool.`;
	}

	return `${header}\n\nDo this workflow step directly in the main agent.\n\n${task}`;
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

export function renderInstructionTemplate(
	template: string,
	values: { tool: string; agent: string; task: string },
): string {
	return template
		.replaceAll("{tool}", values.tool)
		.replaceAll("{agent}", values.agent)
		.replaceAll("{task}", values.task);
}

export function getCurrentLoopCount(ctx: WorkflowContext): number {
	let count = 0;
	const suffix = `->${ctx.step.id}`;
	for (const [key, value] of Object.entries(ctx.loopCounts)) {
		if (key.endsWith(suffix) && value > count) count = value;
	}
	return count;
}
