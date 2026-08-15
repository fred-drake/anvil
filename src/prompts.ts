import { shellEscape } from "./shell.ts";
import type {
	AgentCheck,
	Templatable,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowStep,
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
	const placeholders: CommandPlaceholder[] = [
		{ token: "{input}", variable: "__ANVIL_INPUT", value: ctx.input },
		{ token: "{loop}", variable: "__ANVIL_LOOP", value: String(getCurrentLoopCount(ctx)) },
	];
	if (template.includes("{item}")) placeholders.push({ token: "{item}", variable: "__ANVIL_ITEM", value: ctx.item ?? "" });
	if (template.includes("{itemIndex}")) {
		placeholders.push({ token: "{itemIndex}", variable: "__ANVIL_ITEM_INDEX", value: ctx.itemIndex === undefined ? "" : String(ctx.itemIndex) });
	}
	if (template.includes("{itemCount}")) {
		placeholders.push({ token: "{itemCount}", variable: "__ANVIL_ITEM_COUNT", value: ctx.itemCount === undefined ? "" : String(ctx.itemCount) });
	}
	let outputIndex = 0;
	for (const stepId of referencedOutputIds(template)) {
		placeholders.push({
			token: `{outputs.${stepId}}`,
			variable: `__ANVIL_OUTPUT_${outputIndex}`,
			value: ctx.outputs[stepId] ?? "",
		});
		outputIndex += 1;
	}
	return renderCommandPlaceholders(template, placeholders);
}

function replaceTemplatePlaceholders(
	template: string,
	ctx: WorkflowContext,
	escapeValue: (value: string) => string,
): string {
	// Single pass over the original template: `String.prototype.replace` never rescans
	// substituted text, so a value carrying a `{outputs.x}` (e.g. free-form task input)
	// cannot trigger a further expansion.
	return template.replace(
		/\{input\}|\{loop\}|\{item\}|\{itemIndex\}|\{itemCount\}|\{outputs\.([^}]+)\}/g,
		(match, outputId?: string) => {
			if (match === "{input}") return escapeValue(ctx.input);
			if (match === "{loop}") return escapeValue(String(getCurrentLoopCount(ctx)));
			if (match === "{item}") return escapeValue(ctx.item ?? "");
			if (match === "{itemIndex}") return escapeValue(ctx.itemIndex === undefined ? "" : String(ctx.itemIndex));
			if (match === "{itemCount}") return escapeValue(ctx.itemCount === undefined ? "" : String(ctx.itemCount));
			return escapeValue(ctx.outputs[outputId!] ?? "");
		},
	);
}

function referencedOutputIds(template: string): string[] {
	const ids = new Set<string>();
	for (const match of template.matchAll(/\{outputs\.([^}]+)\}/g)) ids.add(match[1]!);
	return [...ids];
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
	return `${header}\n\nTask:\n${task}`;
}

export async function buildAgentCheckInstruction(args: {
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	check: AgentCheck;
	ctx: WorkflowContext;
	checkId: string;
}): Promise<string> {
	const criteria = await renderTemplatable(args.check.prompt, args.ctx);

	return `[anvil] Workflow "${args.workflow.name}" — evaluate step "${args.step.id}".\n\n` +
		`Evaluation criteria:\n${criteria}\n\n` +
		`Submit exactly one \`anvil_verdict\` tool call: check_id \`${args.checkId}\`, pass true only when the criteria are satisfied, and a concise reason. A prose-only response does not count.`;
}

export function buildVerdictReprompt(checkId: string): string {
	return `[anvil] You did not report a verdict for check_id ${checkId}. Call the \`anvil_verdict\` tool now exactly once with check_id ${checkId}, pass, and reason.`;
}

export function appendFeedback(prompt: string, feedback?: string): string {
	if (!feedback?.trim()) return prompt;
	return `${prompt}\n\n## Feedback from failed check\n${feedback.trim()}`;
}

export function getCurrentLoopCount(ctx: WorkflowContext): number {
	let count = 0;
	const suffix = ctx.itemIndex === undefined ? `->${ctx.step.id}` : `->${ctx.step.id}#${ctx.itemIndex}`;
	for (const [key, value] of Object.entries(ctx.loopCounts)) {
		if (key.endsWith(suffix) && value > count) count = value;
	}
	return count;
}
