import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeSurface, createSurface, herdrUnavailableMessage, isHerdrAvailable, pollForExit, readScreen, sendLongCommand, __testing__ } from "../src/subagent/herdr.ts";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HERDR_ENV = process.env.HERDR_ENV;
const ORIGINAL_HERDR_PANE_ID = process.env.HERDR_PANE_ID;
const ORIGINAL_HERDR_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "anvil-herdr-test-"));
}

afterEach(() => {
	process.env.PATH = ORIGINAL_PATH;
	restoreEnv("HERDR_ENV", ORIGINAL_HERDR_ENV);
	restoreEnv("HERDR_PANE_ID", ORIGINAL_HERDR_PANE_ID);
	restoreEnv("HERDR_WORKSPACE_ID", ORIGINAL_HERDR_WORKSPACE_ID);
	__testing__.resetState();
});

describe("herdr availability", () => {
	it("requires a herdr-managed pane", () => {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
		expect(isHerdrAvailable()).toBe(false);

		process.env.HERDR_ENV = "1";
		expect(isHerdrAvailable()).toBe(false);

		process.env.HERDR_PANE_ID = "1-1";
		expect(isHerdrAvailable()).toBe(true);
	});

	it("explains how to enable herdr subagent delegation", () => {
		expect(herdrUnavailableMessage()).toContain("herdr is not available");
		expect(herdrUnavailableMessage()).toContain('delegation: { subagent: "herdr" }');
	});
});

describe("herdr backend parity with cmux", () => {
	it("creates the first subagent as a right split and later subagents as tabs", async () => {
		const dir = tempDir();
		const logFile = join(dir, "herdr.log");
		installFakeHerdr(dir, logFile);
		process.env.PATH = `${dir}:${ORIGINAL_PATH ?? ""}`;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "1-1";
		process.env.HERDR_WORKSPACE_ID = "1";

		const first = await createSurface("Anvil: research");
		const second = await createSurface("Anvil: implement");

		expect(first).toBe("1-2");
		expect(second).toBe("1-3");
		const calls = readFileSync(logFile, "utf8").trim().split("\n");
		expect(calls[0]).toContain("pane split");
		expect(calls[0]).toContain("--current");
		expect(calls[0]).toContain("--direction right");
		expect(calls[0]).toContain("--no-focus");
		expect(calls[1]).toBe("pane rename 1-2 Anvil: research");
		expect(calls[2]).toContain("tab create");
		expect(calls[2]).toContain("--workspace 1");
		expect(calls[2]).toContain("--label Anvil: implement");
		expect(calls[2]).toContain("--no-focus");
	});

	it("rejects malformed herdr create responses", async () => {
		const dir = tempDir();
		const logFile = join(dir, "herdr.log");
		installFakeHerdr(dir, logFile, { malformedCreate: true });
		process.env.PATH = `${dir}:${ORIGINAL_PATH ?? ""}`;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "1-1";

		await expect(createSurface("Anvil: broken")).rejects.toThrow(/unexpected herdr pane split output|pane_id/i);
	});

	it("runs long commands through owner-only scripts and herdr pane run", async () => {
		const dir = tempDir();
		const logFile = join(dir, "herdr.log");
		const scriptPath = join(dir, "launch.sh");
		installFakeHerdr(dir, logFile);
		process.env.PATH = `${dir}:${ORIGINAL_PATH ?? ""}`;

		await sendLongCommand("1-2", "echo hello", scriptPath);

		expect(statSync(scriptPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(scriptPath, "utf8")).toContain("echo hello");
		expect(readFileSync(logFile, "utf8")).toContain(`pane run 1-2 bash '${scriptPath}'`);
	});

	it("reads and closes herdr panes with the expected CLI commands", async () => {
		const dir = tempDir();
		const logFile = join(dir, "herdr.log");
		installFakeHerdr(dir, logFile);
		process.env.PATH = `${dir}:${ORIGINAL_PATH ?? ""}`;

		await expect(readScreen("1-2", 12)).resolves.toBe("screen contents\n");
		await closeSurface("1-2");

		expect(readFileSync(logFile, "utf8").trim().split("\n")).toEqual([
			"pane read 1-2 --source recent-unwrapped --lines 12",
			"pane close 1-2",
		]);
	});

	it("polls herdr panes with herdr pane read for terminal sentinel detection", async () => {
		const dir = tempDir();
		const logFile = join(dir, "herdr.log");
		installFakeHerdr(dir, logFile, { screenOutput: "__ANVIL_SUBAGENT_DONE_7__" });
		writeFileSync(join(dir, "cmux"), `#!/bin/sh\nprintf '%s\\n' "cmux $*" >> ${shellQuote(logFile)}\nexit 99\n`, {
			mode: 0o755,
		});
		process.env.PATH = `${dir}:${ORIGINAL_PATH ?? ""}`;

		await expect(pollForExit("1-2", join(dir, "session.jsonl"), undefined, 1, 100)).resolves.toEqual({
			reason: "sentinel",
			exitCode: 7,
		});

		expect(readFileSync(logFile, "utf8").trim().split("\n")).toEqual([
			"pane read 1-2 --source recent-unwrapped --lines 5",
		]);
	});
});

function installFakeHerdr(dir: string, logFile: string, options: { malformedCreate?: boolean; screenOutput?: string } = {}): void {
	writeFileSync(
		join(dir, "herdr"),
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${shellQuote(logFile)}
if [ "$1 $2" = "pane split" ]; then
  printf '%s\\n' '${options.malformedCreate ? "{}" : '{"result":{"pane":{"pane_id":"1-2"}}}'}'
  exit 0
fi
if [ "$1 $2" = "tab create" ]; then
  printf '%s\\n' '{"result":{"tab":{"tab_id":"1:2"},"root_pane":{"pane_id":"1-3"}}}'
  exit 0
fi
if [ "$1 $2" = "pane read" ]; then
  printf '%s\\n' ${shellQuote(options.screenOutput ?? "screen contents")}
  exit 0
fi
exit 0
`,
		{ mode: 0o755 },
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
