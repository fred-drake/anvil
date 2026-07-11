import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { AnvilAbortError, throwIfAborted } from "../errors.ts";

export const SUBAGENT_SENTINEL_PREFIX = "__ANVIL_SUBAGENT_DONE_";
const LEGACY_SENTINEL_RE = /^__ANVIL_SUBAGENT_DONE_(\d+)__$/m;
const MISSING_CWD_PROMPT_RE = /^cwd from session file does not exist[\s\S]*?continue in current cwd[\s\S]*?\n\s*(?:→\s*)?Continue\b[\s\S]*?\n\s*Cancel\b/i;
const CONTINUE_CANCEL_PROMPT_RE = /^continue in current cwd[\s\S]*?\n\s*(?:→\s*)?Continue\b[\s\S]*?\n\s*Cancel\b/i;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 1_800_000;
export const DEFAULT_READ_SCREEN_FAILURE_LIMIT = 2;
export const SUBAGENT_PROVIDER_ERROR_MESSAGE = "Subagent exited with stopReason=error; provider details omitted.";

export interface SubagentExit {
	reason: "done" | "error" | "sentinel";
	exitCode: number;
	errorMessage?: string;
}

export type ReadSubagentScreen = (surface: string, lines?: number, signal?: AbortSignal) => Promise<string>;

export function interpretExitSidecar(data: unknown): SubagentExit {
	const record = (typeof data === "object" && data !== null ? data : {}) as { type?: unknown };
	if (record.type === "error") {
		return {
			reason: "error",
			exitCode: 1,
			errorMessage: SUBAGENT_PROVIDER_ERROR_MESSAGE,
		};
	}
	return { reason: "done", exitCode: 0 };
}

const MAX_EXIT_SIDECAR_BYTES = 4096;

async function consumeExitSidecar(sessionFile: string): Promise<SubagentExit | undefined> {
	const exitFile = `${sessionFile}.exit`;
	let handle;
	try {
		handle = await open(exitFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		if (!(await handle.stat()).isFile()) return undefined;
		const buffer = Buffer.alloc(MAX_EXIT_SIDECAR_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_EXIT_SIDECAR_BYTES) return undefined;
		const data = JSON.parse(buffer.toString("utf8", 0, bytesRead));
		await rm(exitFile, { force: true });
		return interpretExitSidecar(data);
	} catch {
		return undefined;
	} finally {
		await handle.close();
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
	sentinelNonce?: string,
): Promise<SubagentExit> {
	const deadline = Date.now() + timeoutMs;
	let consecutiveReadFailures = 0;
	for (;;) {
		throwIfAborted(signal);
		if (Date.now() >= deadline) throw new Error(`Subagent timed out after ${timeoutMs}ms`);

		const sidecar = await consumeExitSidecar(sessionFile);
		if (sidecar) return sidecar;

		try {
			const screen = await readScreenBeforeDeadline(readScreen, surface, deadline, timeoutMs, signal);
			consecutiveReadFailures = 0;
			const sentinelExitCode = detectTerminalSentinel(screen, sentinelNonce);
			if (sentinelExitCode !== undefined) {
				return sentinelExitCode === 0
					? { reason: "sentinel", exitCode: 0 }
					: {
						reason: "sentinel",
						exitCode: sentinelExitCode,
						errorMessage: `Subagent exited with code ${sentinelExitCode}; terminal output omitted.`,
					};
			}
			const blockingPrompt = detectBlockingPiStartupPrompt(screen);
			if (blockingPrompt) return { reason: "error", exitCode: 1, errorMessage: blockingPrompt };
		} catch (error) {
			if (error instanceof SubagentReadTimeoutError || error instanceof AnvilAbortError) throw error;
			// Surface may already be gone — give the child a short grace period to write the sidecar,
			// then fail fast instead of waiting for the full subagent timeout.
			consecutiveReadFailures += 1;
			if (Date.now() >= deadline) throw new Error(`Subagent timed out after ${timeoutMs}ms`);
			if (consecutiveReadFailures >= DEFAULT_READ_SCREEN_FAILURE_LIMIT) {
				const lateSidecar = await consumeExitSidecar(sessionFile);
				if (lateSidecar) return lateSidecar;
				throw new Error(`Subagent surface closed before completion: ${surface}`);
			}
			const lateSidecar = await consumeExitSidecar(sessionFile);
			if (lateSidecar) return lateSidecar;
		}

		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
	}
}

class SubagentReadTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Subagent timed out after ${timeoutMs}ms`);
	}
}

async function readScreenBeforeDeadline(
	readScreen: ReadSubagentScreen,
	surface: string,
	deadline: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw new SubagentReadTimeoutError(timeoutMs);

	const readController = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const guard = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			readController.abort();
			reject(new SubagentReadTimeoutError(timeoutMs));
		}, remainingMs);
		onAbort = () => {
			readController.abort();
			reject(new AnvilAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([readScreen(surface, 5, readController.signal), guard]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// Ensure an in-flight backend subprocess is terminated when another race
		// participant wins or the caller stops polling.
		readController.abort();
	}
}

function detectTerminalSentinel(screen: string, sentinelNonce: string | undefined): number | undefined {
	const match = sentinelNonce
		? screen.match(new RegExp(`^${escapeRegExp(SUBAGENT_SENTINEL_PREFIX)}${escapeRegExp(sentinelNonce)}_(\\d+)__$`, "m"))
		: screen.match(LEGACY_SENTINEL_RE);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function detectBlockingPiStartupPrompt(screen: string): string | undefined {
	const trimmed = screen.trimStart();
	if (MISSING_CWD_PROMPT_RE.test(trimmed)) {
		return "Pi startup prompt blocked subagent auto-exit: cwd from session file does not exist.";
	}
	if (CONTINUE_CANCEL_PROMPT_RE.test(trimmed)) {
		return "Pi startup prompt blocked subagent auto-exit; rerun the step after the session startup prompt is resolved.";
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
