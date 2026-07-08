/**
 * Minimal cmux backend for Anvil's declarative subagent steps.
 *
 * Ported (cmux-only) from HazAT/pi-interactive-subagents: surfaces are cmux
 * tabs; the first subagent creates a right split, later ones add tabs to the
 * same pane. Completion is detected via a `<sessionFile>.exit` sidecar written
 * by the child extension, with the terminal sentinel as crash fallback.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellEscape } from "../shell.ts";
import { interpretExitSidecar, pollForExitWithReadScreen } from "./exit.ts";
import type { SubagentExit } from "./exit.ts";
export {
	DEFAULT_READ_SCREEN_FAILURE_LIMIT,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	SUBAGENT_SENTINEL_PREFIX,
} from "./exit.ts";

const execFileAsync = promisify(execFile);

interface CmuxSurfaceState {
	subagentPane: string | null;
}

/** Default state for direct backend use; extension sessions create their own manager. */
const defaultSurfaceState: CmuxSurfaceState = { subagentPane: null };

export { shellEscape };

/* v8 ignore start -- cmux process/UI launch integration is covered by source-level contracts and manual cmux behavior. */
export function isCmuxAvailable(): boolean {
	return Boolean(process.env.CMUX_SOCKET_PATH);
}

export function cmuxUnavailableMessage(): string {
	return 'cmux is not available. Start pi inside cmux (`cmux pi`) to run workflows with `delegation: { subagent: "cmux" }`.';
}

interface FocusSnapshot {
	surfaceRef?: string;
	paneRef?: string;
}

interface CreatedSurface {
	surface: string;
	paneRef?: string;
}

async function readCmuxJson(args: string[]): Promise<Record<string, unknown> | null> {
	try {
		const { stdout } = await execFileAsync("cmux", args, { encoding: "utf8" });
		if (!stdout.trim()) return null;
		const parsed = JSON.parse(stdout);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function toFocusSnapshot(value: unknown): FocusSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const record = value as { surface_ref?: unknown; pane_ref?: unknown };
	const surfaceRef = typeof record.surface_ref === "string" && record.surface_ref ? record.surface_ref : undefined;
	const paneRef = typeof record.pane_ref === "string" && record.pane_ref ? record.pane_ref : undefined;
	return surfaceRef || paneRef ? { surfaceRef, paneRef } : null;
}

async function captureIdentify(): Promise<{ focused: FocusSnapshot | null; caller: FocusSnapshot | null }> {
	const parsed = await readCmuxJson(["identify", "--json"]);
	return {
		focused: toFocusSnapshot(parsed?.focused),
		caller: toFocusSnapshot(parsed?.caller),
	};
}

async function readPaneRefForSurface(surface: string): Promise<string | undefined> {
	const parsed = await readCmuxJson(["identify", "--surface", surface]);
	if (!parsed) return undefined;
	if (parsed.surface_ref === surface && typeof parsed.pane_ref === "string" && parsed.pane_ref) return parsed.pane_ref;
	const caller = parsed.caller;
	if (caller && typeof caller === "object") {
		const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
		if (record.surface_ref === surface && typeof record.pane_ref === "string" && record.pane_ref) return record.pane_ref;
	}
	return undefined;
}

async function restoreFocus(snapshot: FocusSnapshot | null): Promise<void> {
	if (!snapshot) return;
	try {
		if (snapshot.paneRef) await execFileAsync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
		if (snapshot.surfaceRef) await execFileAsync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
	} catch {
		// Best-effort focus restoration only.
	}
}

function focusMatches(focus: FocusSnapshot | null, snapshot: FocusSnapshot | null | undefined): boolean {
	if (!focus || !snapshot) return false;
	return (!!snapshot.surfaceRef && focus.surfaceRef === snapshot.surfaceRef) || (!!snapshot.paneRef && focus.paneRef === snapshot.paneRef);
}

/**
 * Creating a split/surface can steal keyboard focus. If focus landed on the
 * new child (or settled back onto the caller's pane), put it back where it was.
 */
async function restoreFocusIfStolen(snapshot: FocusSnapshot | null, child: CreatedSurface, caller: FocusSnapshot | null): Promise<void> {
	if (!snapshot) return;
	await sleep(100);
	const current = (await captureIdentify()).focused;
	if (
		focusMatches(current, { surfaceRef: child.surface, paneRef: child.paneRef }) ||
		focusMatches(current, caller)
	) {
		await restoreFocus(snapshot);
	}
}

function parseCreatedSurface(output: string, command: string): CreatedSurface {
	const surfaceMatch = output.match(/surface:\d+/);
	if (!surfaceMatch) throw new Error(`Unexpected cmux ${command} output: ${output}`);
	return { surface: surfaceMatch[0], paneRef: output.match(/pane:\d+/)?.[0] };
}

async function renameSurface(surface: string, name: string): Promise<void> {
	await execFileAsync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}

async function createSplitSurface(name: string): Promise<CreatedSurface> {
	const { focused, caller } = await captureIdentify();
	let child: CreatedSurface | null = null;
	try {
		const args = ["new-split", "right"];
		if (process.env.CMUX_SURFACE_ID) args.push("--surface", process.env.CMUX_SURFACE_ID);
		const { stdout } = await execFileAsync("cmux", args, { encoding: "utf8" });
		child = parseCreatedSurface(stdout.trim(), "new-split");
		child.paneRef ??= await readPaneRefForSurface(child.surface);
		await renameSurface(child.surface, name);
		return child;
	} finally {
		if (child) await restoreFocusIfStolen(focused, child, caller);
		else await restoreFocus(focused);
	}
}

async function createSurfaceInPane(name: string, pane: string): Promise<string> {
	const { focused, caller } = await captureIdentify();
	let child: CreatedSurface | null = null;
	try {
		const { stdout } = await execFileAsync("cmux", ["new-surface", "--pane", pane], { encoding: "utf8" });
		child = parseCreatedSurface(stdout.trim(), "new-surface");
		child.paneRef ??= pane;
		await renameSurface(child.surface, name);
		return child.surface;
	} finally {
		if (child) await restoreFocusIfStolen(focused, child, caller);
		else await restoreFocus(focused);
	}
}

/**
 * Create a terminal surface for a subagent. The first call creates a right
 * split; subsequent calls add tabs to that pane so splits don't keep shrinking.
 * Returns a `surface:<n>` identifier.
 */
export async function createSurface(name: string): Promise<string> {
	return createSurfaceWithState(defaultSurfaceState, name);
}

export function createSurfaceManager(): { createSurface: (name: string) => Promise<string> } {
	const state: CmuxSurfaceState = { subagentPane: null };
	return { createSurface: (name) => createSurfaceWithState(state, name) };
}

async function createSurfaceWithState(state: CmuxSurfaceState, name: string): Promise<string> {
	if (state.subagentPane) {
		try {
			const { stdout: tree } = await execFileAsync("cmux", ["tree"], { encoding: "utf8" });
			if (new RegExp(`(^|\\s)${escapeRegExp(state.subagentPane)}($|\\s)`).test(tree)) {
				return createSurfaceInPane(name, state.subagentPane);
			}
		} catch {}
		state.subagentPane = null;
	}

	const created = await createSplitSurface(name);
	state.subagentPane = created.paneRef ?? null;
	return created.surface;
}

/** Send the subagent launch command directly so the pane runs visible Pi, not a wrapper script. */
export async function sendLongCommand(surface: string, command: string, _scriptPath: string): Promise<void> {
	await execFileAsync("cmux", ["send", "--surface", surface, `${command}\n`], { encoding: "utf8" });
}

export async function readScreen(surface: string, lines = 5): Promise<string> {
	const { stdout } = await execFileAsync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
		encoding: "utf8",
	});
	return stdout;
}

export async function closeSurface(surface: string): Promise<void> {
	await execFileAsync("cmux", ["close-surface", "--surface", surface], { encoding: "utf8" });
}
/* v8 ignore stop */

export type { SubagentExit };

/**
 * Poll until the subagent exits: `.exit` sidecar first (written by the child
 * extension), terminal sentinel as fallback for crashes / early shell errors.
 */
export function pollForExit(
	surface: string,
	sessionFile: string,
	signal?: AbortSignal,
	intervalMs?: number,
	timeoutMs?: number,
	sentinelNonce?: string,
): Promise<SubagentExit> {
	return pollForExitWithReadScreen(readScreen, surface, sessionFile, signal, intervalMs, timeoutMs, sentinelNonce);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __testing__ = { interpretExitSidecar };
