/**
 * Extension loaded into Anvil-spawned subagent sessions (`pi -e .../child.ts`).
 *
 * When the agent finishes its turn, it writes a `<sessionFile>.exit` sidecar
 * (consumed by the parent's pollForExit) and shuts the session down. Turns the
 * user aborted with Escape stay open for inspection; provider-error turns exit
 * with the error message so the parent reports a failure instead of a stale
 * summary.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		return message.errorMessage?.trim() || "Subagent agent loop ended with stopReason=error.";
	}
	return undefined;
}

/* v8 ignore start -- loaded only inside spawned pi subagent sessions. */
export default function anvilSubagentChild(pi: ExtensionAPI) {
	const sessionFile = process.env.PI_ANVIL_SUBAGENT_SESSION;
	if (!sessionFile) return;

	pi.on("agent_end", (event, ctx) => {
		const messages = (event as { messages?: AssistantLike[] }).messages;
		if (!shouldAutoExitOnAgentEnd(messages)) return;

		const errorMessage = findLatestAssistantError(messages);
		try {
			writeFileSync(
				`${sessionFile}.exit`,
				JSON.stringify(errorMessage ? { type: "error", errorMessage } : { type: "done" }),
			);
		} catch {
			// Best effort — the terminal sentinel still reports the exit.
		}
		ctx.shutdown();
	});
}
/* v8 ignore stop */
