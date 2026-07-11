/**
 * Herdr backend for Anvil's declarative subagent steps.
 *
 * Herdr panes are the terminal surfaces. The first subagent creates a right
 * split beside the current Pi pane; later subagents open labelled tabs in the
 * same workspace so the layout does not keep shrinking. Completion detection is
 * shared with cmux via the `.exit` sidecar and terminal sentinel poller.
 */
import { execFile } from "node:child_process";
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

async function runHerdr(args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync(process.env.HERDR_BIN_PATH ?? "herdr", args, { encoding: "utf8", signal });
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

function findStringPath(record: unknown, candidatePaths: string[][]): string | undefined {
	for (const path of candidatePaths) {
		const value = getPath(record, path);
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function parseCreatedPane(output: string, command: string, candidatePaths: string[][]): string {
	const parsed = parseJsonOutput(output, command);
	const paneId = findStringPath(parsed, candidatePaths);
	if (paneId) return paneId;
	throw new Error(`Unexpected herdr ${command} output: missing pane_id in ${output.trim()}`);
}

function inferWorkspaceId(paneId: string | undefined): string | undefined {
	if (!paneId) return undefined;
	const match = paneId.match(/^(\d+)[-:]/);
	return match?.[1];
}

async function createSplitSurface(
	name: string,
	signal?: AbortSignal,
	onCreated?: (surface: string) => void,
): Promise<string> {
	const stdout = await runHerdr(["pane", "split", "--current", "--direction", "right", "--no-focus"], signal);
	const parsed = parseJsonOutput(stdout, "pane split");
	const paneId = findStringPath(parsed, [
		["result", "pane", "pane_id"],
		["result", "root_pane", "pane_id"],
		["pane", "pane_id"],
		["pane_id"],
	]);
	if (!paneId) throw new Error(`Unexpected herdr pane split output: missing pane_id in ${stdout.trim()}`);
	onCreated?.(paneId);
	await runHerdr(["pane", "rename", paneId, name], signal);
	subagentWorkspace =
		findStringPath(parsed, [
			["result", "workspace", "workspace_id"],
			["result", "pane", "workspace_id"],
			["result", "root_pane", "workspace_id"],
			["workspace", "workspace_id"],
			["pane", "workspace_id"],
			["workspace_id"],
		]) ??
		process.env.HERDR_WORKSPACE_ID ??
		inferWorkspaceId(process.env.HERDR_PANE_ID) ??
		inferWorkspaceId(paneId) ??
		null;
	return paneId;
}

async function createTabSurface(
	name: string,
	workspace: string,
	signal?: AbortSignal,
	onCreated?: (surface: string) => void,
): Promise<string> {
	const args = ["tab", "create"];
	if (workspace) args.push("--workspace", workspace);
	args.push("--label", name, "--no-focus");
	const stdout = await runHerdr(args, signal);
	const paneId = parseCreatedPane(stdout, "tab create", [
		["result", "root_pane", "pane_id"],
		["result", "pane", "pane_id"],
		["root_pane", "pane_id"],
		["pane", "pane_id"],
		["pane_id"],
	]);
	onCreated?.(paneId);
	return paneId;
}

/**
 * Create a Herdr pane for a subagent. The first call creates a right split;
 * subsequent calls create labelled tabs in the same workspace.
 */
export async function createSurface(
	name: string,
	signal?: AbortSignal,
	onCreated?: (surface: string) => void,
): Promise<string> {
	if (subagentWorkspace !== null) {
		try {
			return await createTabSurface(name, subagentWorkspace, signal, onCreated);
		} catch (error) {
			if (signal?.aborted) throw error;
			subagentWorkspace = null;
		}
	}
	return createSplitSurface(name, signal, onCreated);
}

/** Send the subagent launch command directly so the pane runs visible Pi, not a wrapper script. */
export async function sendLongCommand(surface: string, command: string, _scriptPath: string, signal?: AbortSignal): Promise<void> {
	await runHerdr(["pane", "run", surface, command], signal);
}

/** Send text to the interactive Pi prompt after bootstrap readiness. */
export async function sendInput(surface: string, input: string): Promise<void> {
	await runHerdr(["pane", "send-text", surface, input]);
	// Accepting an @file mention updates Pi's input state asynchronously. Sending
	// both returns together can leave the second one in the old state.
	await runHerdr(["pane", "send-keys", surface, "ENTER"]);
	await delay(100);
	await runHerdr(["pane", "send-keys", surface, "ENTER"]);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readScreen(surface: string, lines = 5, signal?: AbortSignal): Promise<string> {
	return runHerdr(["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(lines)], signal);
}

export function pollForExit(
	surface: string,
	sessionFile: string,
	signal?: AbortSignal,
	intervalMs?: number,
	timeoutMs?: number,
	sentinelNonce?: string,
): Promise<SubagentExit> {
	const readForPoll = (pane: string, lines = 5, readSignal?: AbortSignal) =>
		readScreen(pane, Math.max(lines, 20), readSignal);
	return pollForExitWithReadScreen(readForPoll, surface, sessionFile, signal, intervalMs, timeoutMs, sentinelNonce);
}

export async function closeSurface(surface: string, signal?: AbortSignal): Promise<void> {
	await runHerdr(["pane", "close", surface], signal);
}

function resetState(): void {
	subagentWorkspace = null;
}

export const __testing__ = { resetState };

// Keep the shared exit type visible from this backend for parity with cmux.
export type { SubagentExit };
