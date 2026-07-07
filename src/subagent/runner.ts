/**
 * Launches a declaratively-delegated workflow step as a pi subagent in a cmux
 * surface, waits for it to finish, and extracts the final assistant message as
 * the step summary.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	closeSurface,
	cmuxUnavailableMessage,
	createSurface,
	isCmuxAvailable,
	pollForExit,
	sendLongCommand,
	shellEscape,
	SUBAGENT_SENTINEL_PREFIX,
} from "./cmux.ts";

export interface SubagentLaunch {
	/** Display name for the cmux tab. */
	name: string;
	/** Full task prompt for the subagent. */
	task: string;
	/** Working directory the subagent starts in. */
	cwd: string;
	runId: string;
	stepId: string;
	/** Pi model reference (provider/id) for the child session. */
	model?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
}

export interface SubagentResult {
	summary: string;
	sessionFile: string;
	exitCode: number;
	errorMessage?: string;
}

const CHILD_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "child.ts");

export function buildSubagentLaunchCommand(args: {
	cwd: string;
	sessionFile: string;
	taskFile: string;
	model?: string;
	thinkingLevel?: string;
	childExtensionPath?: string;
}): string {
	const parts = [
		"pi",
		"--session",
		shellEscape(args.sessionFile),
		"-e",
		shellEscape(args.childExtensionPath ?? CHILD_EXTENSION_PATH),
	];
	if (args.model) parts.push("--model", shellEscape(args.model));
	if (args.thinkingLevel) parts.push("--thinking", shellEscape(args.thinkingLevel));
	parts.push(shellEscape(`@${args.taskFile}`));

	const envPrefix = `PI_ANVIL_SUBAGENT_SESSION=${shellEscape(args.sessionFile)} `;
	return `cd ${shellEscape(args.cwd)} && ${envPrefix}${parts.join(" ")}; echo '${SUBAGENT_SENTINEL_PREFIX}'$?'__'`;
}

export function extractLastAssistantText(sessionFile: string): string | undefined {
	if (!existsSync(sessionFile)) return undefined;
	let last: string | undefined;
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		const text = Array.isArray(content)
			? content
					.filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("\n")
					.trim()
			: "";
		if (text) last = text;
	}
	return last;
}

/* v8 ignore start -- launches real cmux/pi child processes; command building and summary extraction are covered separately. */
export async function runCmuxSubagent(launch: SubagentLaunch, signal?: AbortSignal): Promise<SubagentResult> {
	if (!isCmuxAvailable()) throw new Error(cmuxUnavailableMessage());

	const rootDir = join(tmpdir(), "pi-anvil");
	mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	chmodSync(rootDir, 0o700);
	const workDir = join(rootDir, launch.runId);
	mkdirSync(workDir, { recursive: true, mode: 0o700 });
	chmodSync(workDir, 0o700);
	const base = join(workDir, `${sanitizeForFilename(launch.stepId)}-${Date.now().toString(36)}`);
	const sessionFile = `${base}.jsonl`;
	const taskFile = `${base}.task.md`;
	writeFileSync(taskFile, launch.task, "utf8");

	const command = buildSubagentLaunchCommand({
		cwd: launch.cwd,
		sessionFile,
		taskFile,
		model: launch.model,
		thinkingLevel: launch.thinkingLevel,
	});

	const surface = await createSurface(launch.name);
	try {
		await sendLongCommand(surface, command, `${base}.sh`);
		const exit = await pollForExit(surface, sessionFile, signal, undefined, launch.timeoutMs);
		const summary =
			extractLastAssistantText(sessionFile) ??
			(exit.errorMessage
				? `Subagent error: ${exit.errorMessage}`
				: exit.exitCode !== 0
					? `Subagent exited with code ${exit.exitCode}`
					: "Subagent exited without output.");
		return { summary, sessionFile, exitCode: exit.exitCode, errorMessage: exit.errorMessage };
	} finally {
		try {
			await closeSurface(surface);
		} catch {
			// Surface may already be gone.
		}
	}
}
/* v8 ignore stop */

/* v8 ignore next -- only used by ignored real-process launcher. */
function sanitizeForFilename(value: string): string {
	return value.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}
