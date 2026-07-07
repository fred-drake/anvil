import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLatestAssistantError, shouldAutoExitOnAgentEnd } from "../src/subagent/child.ts";
import { __testing__, pollForExit } from "../src/subagent/cmux.ts";
import { buildSubagentLaunchCommand, extractLastAssistantText } from "../src/subagent/runner.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-anvil-test-"));
}

describe("buildSubagentLaunchCommand", () => {
	it("builds a pi launch command with session, child extension, and sentinel", () => {
		const command = buildSubagentLaunchCommand({
			cwd: "/repo",
			sessionFile: "/tmp/run/step.jsonl",
			taskFile: "/tmp/run/step.task.md",
			childExtensionPath: "/ext/child.ts",
		});

		expect(command).toContain("cd '/repo' && ");
		expect(command).toContain("PI_ANVIL_SUBAGENT_SESSION='/tmp/run/step.jsonl' ");
		expect(command).toContain("pi --session '/tmp/run/step.jsonl' -e '/ext/child.ts'");
		expect(command).toContain("'@/tmp/run/step.task.md'");
		expect(command).toContain("echo '__ANVIL_SUBAGENT_DONE_'$?'__'");
		expect(command).not.toContain("--model");
		expect(command).not.toContain("--thinking");
	});

	it("passes model and thinking level to the child session", () => {
		const command = buildSubagentLaunchCommand({
			cwd: "/repo",
			sessionFile: "/tmp/s.jsonl",
			taskFile: "/tmp/s.task.md",
			childExtensionPath: "/ext/child.ts",
			model: "openai-codex/gpt-5.5",
			thinkingLevel: "high",
		});

		expect(command).toContain("--model 'openai-codex/gpt-5.5'");
		expect(command).toContain("--thinking 'high'");
	});

	it("escapes single quotes in paths", () => {
		const command = buildSubagentLaunchCommand({
			cwd: "/repo/it's here",
			sessionFile: "/tmp/s.jsonl",
			taskFile: "/tmp/s.task.md",
			childExtensionPath: "/ext/child.ts",
		});

		expect(command).toContain("cd '/repo/it'\\''s here'");
	});
});

describe("extractLastAssistantText", () => {
	it("returns the last non-empty assistant text", () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3 }),
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
				JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "All done." }] },
				}),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
				"not json",
			].join("\n"),
			"utf8",
		);

		expect(extractLastAssistantText(sessionFile)).toBe("All done.");
	});

	it("returns undefined for missing files or sessions without assistant text", () => {
		expect(extractLastAssistantText(join(tempDir(), "missing.jsonl"))).toBeUndefined();

		const sessionFile = join(tempDir(), "empty.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "session" }) + "\n", "utf8");
		expect(extractLastAssistantText(sessionFile)).toBeUndefined();
	});
});

describe("child auto-exit helpers", () => {
	it("exits after a normally completed turn", () => {
		expect(shouldAutoExitOnAgentEnd([{ role: "assistant", stopReason: "end" }])).toBe(true);
		expect(shouldAutoExitOnAgentEnd(undefined)).toBe(true);
	});

	it("stays open when the turn was aborted", () => {
		expect(shouldAutoExitOnAgentEnd([{ role: "assistant", stopReason: "aborted" }])).toBe(false);
	});

	it("surfaces provider errors from the latest assistant message", () => {
		expect(findLatestAssistantError([{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }])).toBe("overloaded");
		expect(findLatestAssistantError([{ role: "assistant", stopReason: "error", errorMessage: "  " }])).toContain("stopReason=error");
		expect(findLatestAssistantError([{ role: "assistant", stopReason: "end" }])).toBeUndefined();
		expect(findLatestAssistantError(undefined)).toBeUndefined();
	});
});

describe("pollForExit", () => {
	it("resolves from a done sidecar without touching cmux", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }), "utf8");

		await expect(pollForExit("surface:1", sessionFile)).resolves.toEqual({ reason: "done", exitCode: 0 });
	});

	it("resolves error sidecars with the error message", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "overloaded" }), "utf8");

		await expect(pollForExit("surface:1", sessionFile)).resolves.toEqual({
			reason: "error",
			exitCode: 1,
			errorMessage: "overloaded",
		});
	});

	it("rejects when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(pollForExit("surface:1", join(tempDir(), "s.jsonl"), controller.signal)).rejects.toThrow("aborted");
	});
});

describe("interpretExitSidecar", () => {
	it("treats unknown payloads as done", () => {
		expect(__testing__.interpretExitSidecar({})).toEqual({ reason: "done", exitCode: 0 });
		expect(__testing__.interpretExitSidecar({ type: "error" })).toEqual({
			reason: "error",
			exitCode: 1,
			errorMessage: "Subagent exited with stopReason=error.",
		});
	});
});
