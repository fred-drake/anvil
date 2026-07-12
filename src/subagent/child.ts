/**
 * Child-session behavior activated by Anvil when PI_ANVIL_SUBAGENT_SESSION is set.
 *
 * When the agent finishes its turn, it writes a `<sessionFile>.exit` sidecar
 * (consumed by the parent's pollForExit) and shuts the session down. Turns the
 * user aborted with Escape stay open for inspection; provider-error turns exit
 * with a generic diagnostic so the parent reports a failure without persisting
 * potentially sensitive provider output or a stale summary.
 */
import {
	closeSync,
	constants,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReviewFileAccessError, ReviewFileSystem } from "./review-fs.ts";

export interface IndependentReviewVerdict {
	checkId: string;
	pass: boolean;
	reason: string;
}

export const MAX_REVIEW_VERDICT_BYTES = 16 * 1024;
export const MAX_REVIEW_REASON_BYTES = 4 * 1024;
export const INDEPENDENT_REVIEW_PASS_REASON = "Independent review passed.";
export const INDEPENDENT_REVIEW_FAIL_REASON = "Independent review failed.";
export const SUBAGENT_READY_MARKER = "ready";
export const INDEPENDENT_REVIEW_TOOL_NAMES = ["read", "grep", "find", "ls", "anvil_verdict"] as const;
export const INDEPENDENT_REVIEW_MODE = "review";
const DUPLICATE_REVIEW_VERDICT = `${JSON.stringify({ transport_error: "duplicate" })}\n`;
const CHILD_REGISTRATION_KEY = Symbol.for("@fred-drake/anvil/subagent-child-registered");
const SAFE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Writes exactly one bounded verdict record without following a pre-existing
 * sidecar symlink. A second call atomically replaces the path with a bounded
 * duplicate marker instead of appending or writing through the existing path.
 */
export async function writeIndependentReviewVerdict(
	sessionFile: string,
	verdict: IndependentReviewVerdict,
	onTemporaryPath?: (path: string) => void,
): Promise<void> {
	const sidecarFile = `${sessionFile}.verdict.json`;
	// The filesystem entry is the claim. Keeping successful claims in a process-
	// global Set leaks one path for every review session, while O_EXCL already
	// provides the required atomic duplicate detection.
	if (await sidecarExists(sidecarFile)) {
		await replaceSidecarAtomically(sidecarFile, DUPLICATE_REVIEW_VERDICT, onTemporaryPath);
		return;
	}

	try {
		if (Buffer.byteLength(verdict.reason, "utf8") > MAX_REVIEW_REASON_BYTES) {
			throw new Error(`Independent review reason exceeds ${MAX_REVIEW_REASON_BYTES} bytes.`);
		}
		if (containsUnsafeControlCharacters(verdict.reason)) {
			throw new Error("Independent review reason contains unsupported control characters.");
		}
		// A reviewer can quote arbitrary workspace or provider data in its reason.
		// Never persist that untrusted text: checkpoints, UI, retry prompts, and
		// resume prompts all consume the parsed reason. Preserve only pass/fail as
		// useful reviewer output and replace prose with a parent-controlled reason.
		const reason = independentReviewReason(verdict.pass);
		const record = `${JSON.stringify({ check_id: verdict.checkId, pass: verdict.pass, reason })}\n`;
		if (Buffer.byteLength(record, "utf8") > MAX_REVIEW_VERDICT_BYTES) {
			throw new Error(`Independent review verdict exceeds ${MAX_REVIEW_VERDICT_BYTES} bytes.`);
		}
		await createSidecarExclusively(sidecarFile, record);
	} catch (error) {
		if (isAlreadyExistsError(error) || await sidecarExists(sidecarFile)) {
			await replaceSidecarAtomically(sidecarFile, DUPLICATE_REVIEW_VERDICT, onTemporaryPath);
			return;
		}
		throw error;
	}
}

export function independentReviewReason(pass: boolean): string {
	return pass ? INDEPENDENT_REVIEW_PASS_REASON : INDEPENDENT_REVIEW_FAIL_REASON;
}

async function sidecarExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

async function createSidecarExclusively(path: string, content: string): Promise<void> {
	const handle = await open(path, SAFE_CREATE_FLAGS, 0o600);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

export function atomicSidecarTemporaryPath(path: string): string {
	// Keep the temporary basename independent of the near-limit final basename.
	// rename still remains atomic because the temporary lives in the same directory.
	return join(dirname(path), `.anvil-sidecar-${randomUUID()}.tmp`);
}

async function replaceSidecarAtomically(
	path: string,
	content: string,
	onTemporaryPath?: (path: string) => void,
): Promise<void> {
	const temporary = atomicSidecarTemporaryPath(path);
	onTemporaryPath?.(temporary);
	try {
		await createSidecarExclusively(temporary, content);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function replaceSidecarAtomicallySync(
	path: string,
	content: string,
	onTemporaryPath?: (path: string) => void,
): void {
	const temporary = atomicSidecarTemporaryPath(path);
	onTemporaryPath?.(temporary);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, SAFE_CREATE_FLAGS, 0o600);
		writeFileSync(descriptor, content, "utf8");
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
}

export function containsUnsafeControlCharacters(value: string): boolean {
	return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function writeSubagentReadySidecar(
	sessionFile: string,
	onTemporaryPath?: (path: string) => void,
): void {
	replaceSidecarAtomicallySync(`${sessionFile}.ready`, SUBAGENT_READY_MARKER, onTemporaryPath);
}

export function writeSubagentExitSidecar(
	sessionFile: string,
	errorMessage?: string,
	onTemporaryPath?: (path: string) => void,
): void {
	replaceSidecarAtomicallySync(
		`${sessionFile}.exit`,
		JSON.stringify(errorMessage ? { type: "error", errorMessage } : { type: "done" }),
		onTemporaryPath,
	);
}

export function independentReviewVerdictReceipt() {
	return {
		content: [{ type: "text" as const, text: "Anvil verdict recorded." }],
		details: { recorded: true },
	};
}

function reviewToolResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { confined: true },
	};
}

function reviewFileSystem(root: string | undefined): Promise<ReviewFileSystem> {
	return root
		? ReviewFileSystem.create(root)
		: Promise.reject(new ReviewFileAccessError("Independent review cwd is unavailable."));
}

export function registerReviewFilesystemTools(
	pi: ExtensionAPI,
	root = process.env.PI_ANVIL_REVIEW_ROOT,
): void {
	let filesystem: Promise<ReviewFileSystem> | undefined;
	const getFilesystem = () => filesystem ??= reviewFileSystem(root);
	pi.registerTool(
		defineTool({
			name: "read",
			label: "Review Read",
			description: "Read a bounded UTF-8 file inside the review workspace. Secret-like paths and symlink escapes are denied.",
			parameters: Type.Object({
				path: Type.String({ description: "Workspace-relative file path." }),
				offset: Type.Optional(Type.Number({ description: "First line to return (1-indexed)." })),
				limit: Type.Optional(Type.Number({ description: "Maximum lines to return (up to 500)." })),
			}),
			async execute(_toolCallId, params, signal) {
				return reviewToolResult(await (await getFilesystem()).read(params.path, params, signal));
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "ls",
			label: "Review List",
			description: "List a bounded directory inside the review workspace without exposing secret-like entries.",
			parameters: Type.Object({
				path: Type.Optional(Type.String({ description: "Workspace-relative directory path. Defaults to the workspace root." })),
				limit: Type.Optional(Type.Number({ description: "Maximum entries to return (up to 500)." })),
			}),
			async execute(_toolCallId, params, signal) {
				return reviewToolResult(await (await getFilesystem()).ls(params.path, params.limit, signal));
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "find",
			label: "Review Find",
			description: "Find workspace paths by a bounded glob. Symlinks and secret-like paths are skipped.",
			parameters: Type.Object({
				pattern: Type.String({ description: "Glob matched against workspace-relative paths or basenames." }),
				path: Type.Optional(Type.String({ description: "Workspace-relative starting directory." })),
				limit: Type.Optional(Type.Number({ description: "Maximum matches to return (up to 500)." })),
			}),
			async execute(_toolCallId, params, signal) {
				return reviewToolResult(await (await getFilesystem()).find(params.pattern, params, signal));
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "grep",
			label: "Review Grep",
			description: "Search bounded workspace text files for a literal string. Symlinks and secret-like paths are skipped.",
			parameters: Type.Object({
				pattern: Type.String({ description: "Literal text to search for." }),
				path: Type.Optional(Type.String({ description: "Workspace-relative file or directory." })),
				glob: Type.Optional(Type.String({ description: "Optional file-path glob." })),
				ignoreCase: Type.Optional(Type.Boolean({ description: "Use case-insensitive matching." })),
				limit: Type.Optional(Type.Number({ description: "Maximum matches to return (up to 500)." })),
			}),
			async execute(_toolCallId, params, signal) {
				return reviewToolResult(await (await getFilesystem()).grep(params.pattern, params, signal));
			},
		}),
	);
}

interface AssistantLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function shouldAutoExitOnAgentEnd(messages: AssistantLike[] | undefined): boolean {
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "assistant") return message.stopReason !== "aborted";
		}
	}
	return true;
}

export function findLatestAssistantError(messages: AssistantLike[] | undefined): string | undefined {
	if (!messages) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error") return undefined;
		return "Subagent agent loop ended with stopReason=error; provider details omitted.";
	}
	return undefined;
}

/* v8 ignore start -- loaded only inside spawned pi subagent sessions. */
export default function anvilSubagentChild(pi: ExtensionAPI) {
	const sessionFile = process.env.PI_ANVIL_SUBAGENT_SESSION;
	if (!sessionFile || isChildAlreadyRegistered()) return;
	markChildRegistered();
	if (process.env.PI_ANVIL_SUBAGENT_MODE === INDEPENDENT_REVIEW_MODE) {
		registerReviewFilesystemTools(pi);
		pi.registerTool(
			defineTool({
				name: "anvil_verdict",
				label: "Anvil Verdict",
				description: "Report the pass/fail verdict for an independent Anvil review.",
				parameters: Type.Object({
					check_id: Type.String({ description: "The exact check_id provided by Anvil." }),
					pass: Type.Boolean({ description: "Whether the check passed." }),
					reason: Type.String({ description: "Concise reason for the verdict." }),
				}),
				async execute(_toolCallId, params) {
					await writeIndependentReviewVerdict(sessionFile, {
						checkId: params.check_id,
						pass: params.pass,
						reason: params.reason,
					});
					return independentReviewVerdictReceipt();
				},
			}),
		);
	}

	pi.on("agent_end", (event, ctx) => {
		const messages = (event as { messages?: AssistantLike[] }).messages;
		if (!shouldAutoExitOnAgentEnd(messages)) return;

		const errorMessage = findLatestAssistantError(messages);
		try {
			writeSubagentExitSidecar(sessionFile, errorMessage);
		} catch {
			// Best effort — the terminal sentinel still reports the exit.
		}
		ctx.shutdown();
	});
	writeSubagentReadySidecar(sessionFile);
}

function isChildAlreadyRegistered(): boolean {
	return Boolean((globalThis as { [CHILD_REGISTRATION_KEY]?: boolean })[CHILD_REGISTRATION_KEY]);
}

function markChildRegistered(): void {
	(globalThis as { [CHILD_REGISTRATION_KEY]?: boolean })[CHILD_REGISTRATION_KEY] = true;
}
/* v8 ignore stop */
