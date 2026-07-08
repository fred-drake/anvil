import { existsSync, readFileSync, rmSync } from "node:fs";
import { AnvilAbortError, throwIfAborted } from "../errors.ts";

export const SUBAGENT_SENTINEL_PREFIX = "__ANVIL_SUBAGENT_DONE_";
const SENTINEL_RE = /__ANVIL_SUBAGENT_DONE_(\d+)__/;
const MISSING_CWD_PROMPT_RE = /cwd from session file does not exist[\s\S]*?continue in current cwd[\s\S]*?(?:^|\n)\s*(?:→\s*)?Continue\b[\s\S]*?(?:^|\n)\s*Cancel\b/im;
const CONTINUE_CANCEL_PROMPT_RE = /continue in current cwd[\s\S]*?(?:^|\n)\s*(?:→\s*)?Continue\b[\s\S]*?(?:^|\n)\s*Cancel\b/im;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 1_800_000;
export const DEFAULT_READ_SCREEN_FAILURE_LIMIT = 2;

export interface SubagentExit {
	reason: "done" | "error" | "sentinel";
	exitCode: number;
	errorMessage?: string;
}

export type ReadSubagentScreen = (surface: string, lines?: number) => Promise<string>;

export function interpretExitSidecar(data: unknown): SubagentExit {
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
 *
 * The screen reader is injected by each multiplexer backend so Herdr panes are
 * polled with `herdr pane read` and cmux surfaces with `cmux read-screen`.
 */
export async function pollForExitWithReadScreen(
	readScreen: ReadSubagentScreen,
	surface: string,
	sessionFile: string,
	signal?: AbortSignal,
	intervalMs = 1000,
	timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
): Promise<SubagentExit> {
	const deadline = Date.now() + timeoutMs;
	let consecutiveReadFailures = 0;
	for (;;) {
		throwIfAborted(signal);
		if (Date.now() >= deadline) throw new Error(`Subagent timed out after ${timeoutMs}ms`);

		const sidecar = consumeExitSidecar(sessionFile);
		if (sidecar) return sidecar;

		try {
			const screen = await readScreen(surface, 5);
			consecutiveReadFailures = 0;
			const match = screen.match(SENTINEL_RE);
			if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1]!, 10) };
			const blockingPrompt = detectBlockingPiStartupPrompt(screen);
			if (blockingPrompt) return { reason: "error", exitCode: 1, errorMessage: blockingPrompt };
		} catch {
			// Surface may already be gone — give the child a short grace period to write the sidecar,
			// then fail fast instead of waiting for the full subagent timeout.
			if (Date.now() >= deadline) throw new Error(`Subagent timed out after ${timeoutMs}ms`);
			const lateSidecar = consumeExitSidecar(sessionFile);
			if (lateSidecar) return lateSidecar;
			consecutiveReadFailures += 1;
			if (consecutiveReadFailures >= DEFAULT_READ_SCREEN_FAILURE_LIMIT) {
				throw new Error(`Subagent surface closed before completion: ${surface}`);
			}
		}

		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
	}
}

function detectBlockingPiStartupPrompt(screen: string): string | undefined {
	if (MISSING_CWD_PROMPT_RE.test(screen)) {
		return "Pi startup prompt blocked subagent auto-exit: cwd from session file does not exist.";
	}
	if (CONTINUE_CANCEL_PROMPT_RE.test(screen)) {
		return "Pi startup prompt blocked subagent auto-exit; rerun the step after the session startup prompt is resolved.";
	}
	return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AnvilAbortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new AnvilAbortError());
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
