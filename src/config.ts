import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AnvilPathOptions } from "./paths.ts";
import { ensureParentDir, getConfigPaths } from "./paths.ts";

export interface SubagentToolConfig {
	kind: "tool";
	toolName: string;
	instructionTemplate: string;
}

export interface SubagentNoneConfig {
	kind: "none";
}

export type SubagentConfig = SubagentToolConfig | SubagentNoneConfig;

export interface AnvilConfig {
	subagent?: SubagentConfig;
}

export type SubagentResolution =
	| { kind: "tool"; config: SubagentToolConfig; saved?: "user" | "project" }
	| { kind: "none"; saved?: "user" | "project" };

export const DEFAULT_SUBAGENT_TOOL_CONFIG: SubagentToolConfig = {
	kind: "tool",
	toolName: "subagent",
	instructionTemplate: 'Use the {tool} tool with agent "{agent}" and this task: {task}',
};

const CANDIDATE_TOOL_RE = /agent|task|delegate/i;

export async function loadAnvilConfig(options: AnvilPathOptions = {}): Promise<AnvilConfig> {
	const paths = getConfigPaths(options);
	const user = await readConfigFile(paths.user);
	const project = await readConfigFile(paths.project);
	return { ...user, ...project };
}

export async function saveAnvilConfig(
	scope: "user" | "project",
	config: AnvilConfig,
	options: AnvilPathOptions = {},
): Promise<void> {
	const paths = getConfigPaths(options);
	const file = scope === "user" ? paths.user : paths.project;
	await ensureParentDir(file);
	await writeFile(file, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

export async function resolveSubagentConfig(args: {
	pi: Pick<ExtensionAPI, "getAllTools">;
	ctx: ExtensionCommandContext;
	cwd: string;
	homeDir?: string;
	forcePicker?: boolean;
}): Promise<SubagentResolution> {
	const options = { cwd: args.cwd, homeDir: args.homeDir };
	if (!args.forcePicker) {
		const config = await loadAnvilConfig(options);
		if (config.subagent?.kind === "tool") {
			warnIfToolMissing(args.pi.getAllTools(), config.subagent, args.ctx);
			return { kind: "tool", config: config.subagent };
		}
		if (config.subagent?.kind === "none") return { kind: "none" };

		const builtIn = args.pi.getAllTools().find((tool) => tool.name === DEFAULT_SUBAGENT_TOOL_CONFIG.toolName);
		if (builtIn) {
			await saveAnvilConfig("user", { subagent: DEFAULT_SUBAGENT_TOOL_CONFIG }, options);
			args.ctx.ui.notify('Anvil configured the "subagent" tool for delegation.', "info");
			return { kind: "tool", config: DEFAULT_SUBAGENT_TOOL_CONFIG, saved: "user" };
		}
	}

	return pickSubagentConfig(args.pi.getAllTools(), args.ctx, options);
}

async function pickSubagentConfig(
	tools: ToolInfo[],
	ctx: ExtensionCommandContext,
	options: AnvilPathOptions,
): Promise<SubagentResolution> {
	const candidates = tools.filter(
		(tool) => CANDIDATE_TOOL_RE.test(tool.name) || CANDIDATE_TOOL_RE.test(tool.description ?? ""),
	);
	const candidateLabels = candidates.map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
	const enterManually = "Enter manually";
	const none = "None — run all steps in main agent";
	const choice = await ctx.ui.select("Select the tool Anvil should use for subagent delegation", [
		...candidateLabels,
		enterManually,
		none,
	]);

	if (!choice) return { kind: "none" };

	if (choice === none) {
		const scope = await chooseConfigScope(ctx);
		await saveAnvilConfig(scope, { subagent: { kind: "none" } }, options);
		ctx.ui.notify(`Anvil will run steps in the main agent (saved to ${scope} config).`, "warning");
		return { kind: "none", saved: scope };
	}

	let toolName: string | undefined = candidates[candidateLabels.indexOf(choice)]?.name;
	if (choice === enterManually) {
		const manual = await ctx.ui.input("Subagent tool name", DEFAULT_SUBAGENT_TOOL_CONFIG.toolName);
		toolName = manual?.trim();
	}

	if (!toolName) {
		ctx.ui.notify("No subagent tool selected; Anvil will run steps in the main agent for now.", "warning");
		return { kind: "none" };
	}

	const selectedToolName = toolName;
	const config: SubagentToolConfig = { ...DEFAULT_SUBAGENT_TOOL_CONFIG, toolName: selectedToolName };
	const scope = await chooseConfigScope(ctx);
	await saveAnvilConfig(scope, { subagent: config }, options);
	ctx.ui.notify(`Anvil subagent delegation saved to ${scope} config (${selectedToolName}).`, "info");
	return { kind: "tool", config, saved: scope };
}

async function chooseConfigScope(ctx: ExtensionCommandContext): Promise<"user" | "project"> {
	const project = await ctx.ui.confirm(
		"Persist Anvil config",
		"Save to the project config (.pi/anvil/config.json)? Choose No to save to your user config (~/.pi/agent/anvil/config.json).",
	);
	return project ? "project" : "user";
}

function warnIfToolMissing(tools: ToolInfo[], config: SubagentToolConfig, ctx: ExtensionContext): void {
	if (!tools.some((tool) => tool.name === config.toolName)) {
		ctx.ui.notify(
			`Anvil is configured to delegate via "${config.toolName}", but that tool is not currently active.`,
			"warning",
		);
	}
}

async function readConfigFile(file: string): Promise<AnvilConfig> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
		return normalizeConfig(parsed);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw new Error(`Failed to read Anvil config ${file}: ${formatError(error)}`);
	}
}

function normalizeConfig(value: unknown): AnvilConfig {
	if (!isRecord(value) || !isRecord(value.subagent)) return {};
	const raw = value.subagent;
	if (raw.kind === "none") return { subagent: { kind: "none" } };
	if (raw.kind === "tool" && typeof raw.toolName === "string" && raw.toolName.length > 0) {
		return {
			subagent: {
				kind: "tool",
				toolName: raw.toolName,
				instructionTemplate:
					typeof raw.instructionTemplate === "string" && raw.instructionTemplate.length > 0
						? raw.instructionTemplate
						: DEFAULT_SUBAGENT_TOOL_CONFIG.instructionTemplate,
			},
		};
	}
	return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
