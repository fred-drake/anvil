/**
 * Herdr backend for Anvil's declarative subagent steps.
 *
 * Herdr panes are the terminal surfaces. The first subagent creates a right
 * split beside the current Pi pane; later subagents open labelled tabs in the
 * same workspace so the layout does not keep shrinking. Completion detection is
 * shared with cmux via the `.exit` sidecar and terminal sentinel poller.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { shellEscape } from "../shell.ts";
import { pollForExitWithReadScreen } from "./exit.ts";
import type { SubagentExit } from "./exit.ts";

const execFileAsync = promisify(execFile);

/** Workspace used for Anvil subagent tabs after the initial split. */
let subagentWorkspace: string | null = null;

export { shellEscape };

export function isHerdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

export function herdrUnavailableMessage(): string {
	return 'herdr is not available. Start pi inside herdr to run workflows with `delegation: { subagent: "herdr" }`.';
}

async function runHerdr(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(process.env.HERDR_BIN_PATH ?? "herdr", args, { encoding: "utf8" });
	return stdout;
}

function parseJsonOutput(output: string, command: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(output);
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {}
	throw new Error(`Unexpected herdr ${command} output: ${output.trim()}`);
}

function getPath(record: unknown, path: string[]): unknown {
	let current = record;
	for (const part of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function parseCreatedPane(output: string, command: string, candidatePaths: string[][]): string {
	const parsed = parseJsonOutput(output, command);
	for (const path of candidatePaths) {
		const value = getPath(parsed, path);
		if (typeof value === "string" && value.trim()) return value;
	}
	throw new Error(`Unexpected herdr ${command} output: missing pane_id in ${output.trim()}`);
}

function inferWorkspaceId(paneId: string | undefined): string | undefined {
	if (!paneId) return undefined;
	const match = paneId.match(/^(\d+)[-:]/);
	return match?.[1];
}

async function createSplitSurface(name: string): Promise<string> {
	const stdout = await runHerdr(["pane", "split", "--current", "--direction", "right", "--no-focus"]);
	const paneId = parseCreatedPane(stdout, "pane split", [
		["result", "pane", "pane_id"],
		["result", "root_pane", "pane_id"],
		["pane", "pane_id"],
		["pane_id"],
	]);
	await runHerdr(["pane", "rename", paneId, name]);
	// Empty string means "ask Herdr to use the current workspace" when no stable id is available.
	subagentWorkspace = process.env.HERDR_WORKSPACE_ID || inferWorkspaceId(process.env.HERDR_PANE_ID) || inferWorkspaceId(paneId) || "";
	return paneId;
}

async function createTabSurface(name: string, workspace: string): Promise<string> {
	const args = ["tab", "create"];
	if (workspace) args.push("--workspace", workspace);
	args.push("--label", name, "--no-focus");
	const stdout = await runHerdr(args);
	return parseCreatedPane(stdout, "tab create", [
		["result", "root_pane", "pane_id"],
		["result", "pane", "pane_id"],
		["root_pane", "pane_id"],
		["pane", "pane_id"],
		["pane_id"],
	]);
}

/**
 * Create a Herdr pane for a subagent. The first call creates a right split;
 * subsequent calls create labelled tabs in the same workspace.
 */
export async function createSurface(name: string): Promise<string> {
	if (subagentWorkspace !== null) return createTabSurface(name, subagentWorkspace);
	return createSplitSurface(name);
}

/**
 * Send a command by writing it to a script file and executing that script in
 * the pane, so long commands survive terminal line-wrapping.
 */
export async function sendLongCommand(surface: string, command: string, scriptPath: string): Promise<void> {
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(scriptPath, `#!/bin/bash\n${command}\n`, { mode: 0o600 });
	await runHerdr(["pane", "run", surface, `bash ${shellEscape(scriptPath)}`]);
}

export async function readScreen(surface: string, lines = 5): Promise<string> {
	return runHerdr(["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(lines)]);
}

export function pollForExit(
	surface: string,
	sessionFile: string,
	signal?: AbortSignal,
	intervalMs?: number,
	timeoutMs?: number,
): Promise<SubagentExit> {
	const readForPoll = (pane: string, lines = 5) => readScreen(pane, Math.max(lines, 20));
	return pollForExitWithReadScreen(readForPoll, surface, sessionFile, signal, intervalMs, timeoutMs);
}

export async function closeSurface(surface: string): Promise<void> {
	await runHerdr(["pane", "close", surface]);
}

function resetState(): void {
	subagentWorkspace = null;
}

export const __testing__ = { resetState };

// Keep the shared exit type visible from this backend for parity with cmux.
export type { SubagentExit };
