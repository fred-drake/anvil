/**
 * Minimal cmux backend for Anvil's declarative subagent steps.
 *
 * Ported (cmux-only) from HazAT/pi-interactive-subagents: surfaces are cmux
 * tabs; the first subagent creates a right split, later ones add tabs to the
 * same pane. Completion is detected via a `<sessionFile>.exit` sidecar written
 * by the child extension, with the terminal sentinel as crash fallback.
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export const SUBAGENT_SENTINEL_PREFIX = "__ANVIL_SUBAGENT_DONE_";
const SENTINEL_RE = /__ANVIL_SUBAGENT_DONE_(\d+)__/;

/** Tracked subagent pane — reused across launches so tabs stack instead of splitting. */
let subagentPane: string | null = null;

export function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isCmuxAvailable(): boolean {
	if (!process.env.CMUX_SOCKET_PATH) return false;
	const result = spawnSync("cmux", ["--version"], { encoding: "utf8" });
	return !result.error;
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

function readCmuxJson(args: string[]): Record<string, unknown> | null {
	const result = spawnSync("cmux", args, { encoding: "utf8" });
	if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
	try {
		const parsed = JSON.parse(result.stdout);
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

function captureIdentify(): { focused: FocusSnapshot | null; caller: FocusSnapshot | null } {
	const parsed = readCmuxJson(["identify", "--json"]);
	return {
		focused: toFocusSnapshot(parsed?.focused),
		caller: toFocusSnapshot(parsed?.caller),
	};
}

function readPaneRefForSurface(surface: string): string | undefined {
	const parsed = readCmuxJson(["identify", "--surface", surface]);
	if (!parsed) return undefined;
	if (parsed.surface_ref === surface && typeof parsed.pane_ref === "string" && parsed.pane_ref) return parsed.pane_ref;
	const caller = parsed.caller;
	if (caller && typeof caller === "object") {
		const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
		if (record.surface_ref === surface && typeof record.pane_ref === "string" && record.pane_ref) return record.pane_ref;
	}
	return undefined;
}

function restoreFocus(snapshot: FocusSnapshot | null): void {
	if (!snapshot) return;
	if (snapshot.paneRef) spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
	if (snapshot.surfaceRef) spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
}

function focusMatches(focus: FocusSnapshot | null, snapshot: FocusSnapshot | null | undefined): boolean {
	if (!focus || !snapshot) return false;
	return (!!snapshot.surfaceRef && focus.surfaceRef === snapshot.surfaceRef) || (!!snapshot.paneRef && focus.paneRef === snapshot.paneRef);
}

/**
 * Creating a split/surface can steal keyboard focus. If focus landed on the
 * new child (or settled back onto the caller's pane), put it back where it was.
 */
function restoreFocusIfStolen(snapshot: FocusSnapshot | null, child: CreatedSurface, caller: FocusSnapshot | null): void {
	if (!snapshot) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	const current = captureIdentify().focused;
	if (
		focusMatches(current, { surfaceRef: child.surface, paneRef: child.paneRef }) ||
		focusMatches(current, caller)
	) {
		restoreFocus(snapshot);
	}
}

function parseCreatedSurface(output: string, command: string): CreatedSurface {
	const surfaceMatch = output.match(/surface:\d+/);
	if (!surfaceMatch) throw new Error(`Unexpected cmux ${command} output: ${output}`);
	return { surface: surfaceMatch[0], paneRef: output.match(/pane:\d+/)?.[0] };
}

function renameSurface(surface: string, name: string): void {
	execFileSync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}

function createSplitSurface(name: string): CreatedSurface {
	const { focused, caller } = captureIdentify();
	let child: CreatedSurface | null = null;
	try {
		const args = ["new-split", "right"];
		if (process.env.CMUX_SURFACE_ID) args.push("--surface", process.env.CMUX_SURFACE_ID);
		const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
		child = parseCreatedSurface(output, "new-split");
		child.paneRef ??= readPaneRefForSurface(child.surface);
		renameSurface(child.surface, name);
		return child;
	} finally {
		if (child) restoreFocusIfStolen(focused, child, caller);
		else restoreFocus(focused);
	}
}

function createSurfaceInPane(name: string, pane: string): string {
	const { focused, caller } = captureIdentify();
	let child: CreatedSurface | null = null;
	try {
		const output = execFileSync("cmux", ["new-surface", "--pane", pane], { encoding: "utf8" }).trim();
		child = parseCreatedSurface(output, "new-surface");
		child.paneRef ??= pane;
		renameSurface(child.surface, name);
		return child.surface;
	} finally {
		if (child) restoreFocusIfStolen(focused, child, caller);
		else restoreFocus(focused);
	}
}

/**
 * Create a terminal surface for a subagent. The first call creates a right
 * split; subsequent calls add tabs to that pane so splits don't keep shrinking.
 * Returns a `surface:<n>` identifier.
 */
export function createSurface(name: string): string {
	if (subagentPane) {
		try {
			const tree = execSync("cmux tree", { encoding: "utf8" });
			if (tree.includes(subagentPane)) return createSurfaceInPane(name, subagentPane);
		} catch {}
		subagentPane = null;
	}

	const created = createSplitSurface(name);
	subagentPane = created.paneRef ?? null;
	return created.surface;
}

/**
 * Send a command by writing it to a script file and executing that, so long
 * commands survive terminal line-wrapping. The script is kept for debugging.
 */
export function sendLongCommand(surface: string, command: string, scriptPath: string): void {
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(scriptPath, `#!/bin/bash\n${command}\n`, { mode: 0o755 });
	execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(`bash ${shellEscape(scriptPath)}\n`)}`, {
		encoding: "utf8",
	});
}

export async function readScreen(surface: string, lines = 5): Promise<string> {
	const { stdout } = await execFileAsync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
		encoding: "utf8",
	});
	return stdout;
}

export function closeSurface(surface: string): void {
	execSync(`cmux close-surface --surface ${shellEscape(surface)}`, { encoding: "utf8" });
}

export interface SubagentExit {
	reason: "done" | "error" | "sentinel";
	exitCode: number;
	errorMessage?: string;
}

function interpretExitSidecar(data: unknown): SubagentExit {
	const record = (typeof data === "object" && data !== null ? data : {}) as { type?: unknown; errorMessage?: unknown };
	if (record.type === "error") {
		const errorMessage =
			typeof record.errorMessage === "string" && record.errorMessage.trim()
				? record.errorMessage
				: "Subagent exited with stopReason=error.";
		return { reason: "error", exitCode: 1, errorMessage };
	}
	return { reason: "done", exitCode: 0 };
}

function consumeExitSidecar(sessionFile: string): SubagentExit | undefined {
	try {
		const exitFile = `${sessionFile}.exit`;
		if (!existsSync(exitFile)) return undefined;
		const data = JSON.parse(readFileSync(exitFile, "utf8"));
		rmSync(exitFile, { force: true });
		return interpretExitSidecar(data);
	} catch {
		return undefined;
	}
}

/**
 * Poll until the subagent exits: `.exit` sidecar first (written by the child
 * extension), terminal sentinel as fallback for crashes / early shell errors.
 */
export async function pollForExit(
	surface: string,
	sessionFile: string,
	signal?: AbortSignal,
	intervalMs = 1000,
): Promise<SubagentExit> {
	for (;;) {
		if (signal?.aborted) throw new Error("Anvil run aborted");

		const sidecar = consumeExitSidecar(sessionFile);
		if (sidecar) return sidecar;

		try {
			const screen = await readScreen(surface, 5);
			const match = screen.match(SENTINEL_RE);
			if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1]!, 10) };
		} catch {
			// Surface may already be gone — the sidecar may still have landed.
			const lateSidecar = consumeExitSidecar(sessionFile);
			if (lateSidecar) return lateSidecar;
		}

		await sleep(intervalMs, signal);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Anvil run aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new Error("Anvil run aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const __testing__ = { interpretExitSidecar };
