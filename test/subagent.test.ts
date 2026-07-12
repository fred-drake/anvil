import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ReviewSubagentUnavailableError } from "../src/errors.ts";
import { normalizeIndependentReviewIdentity } from "../src/prompts.ts";
import {
	findLatestAssistantError,
	INDEPENDENT_REVIEW_FAIL_REASON,
	INDEPENDENT_REVIEW_PASS_REASON,
	INDEPENDENT_REVIEW_TOOL_NAMES,
	independentReviewVerdictReceipt,
	MAX_REVIEW_REASON_BYTES,
	registerReviewFilesystemTools,
	shouldAutoExitOnAgentEnd,
	writeIndependentReviewVerdict,
	writeSubagentExitSidecar,
	writeSubagentReadySidecar,
} from "../src/subagent/child.ts";
import { __testing__, pollForExit, sendInput, sendLongCommand, type SubagentExit } from "../src/subagent/cmux.ts";
import { pollForExitWithReadScreen } from "../src/subagent/exit.ts";
import {
	DARWIN_DESCRIPTOR_VALIDATION_TIMEOUT_MS,
	MAX_DARWIN_DIRECTORY_ENTRIES_PER_SUBPROCESS,
	MAX_DARWIN_DIRECTORY_SUBPROCESSES,
	MAX_REVIEW_DIRECTORY_ENTRIES,
	MAX_REVIEW_READ_BYTES,
	MAX_REVIEW_SEARCH_BYTES,
	MAX_REVIEW_TOOL_OUTPUT_BYTES,
	ReviewFileAccessError,
	ReviewFileSystem,
	__testing__ as reviewFsTesting,
	validateOpenedHandle,
} from "../src/subagent/review-fs.ts";
import {
	__testing__ as runnerTesting,
	buildReviewSubagentBootstrapCommand,
	buildSubagentBootstrapCommand,
	extractLastAssistantText,
	MAX_SUBAGENT_SESSION_SCAN_BYTES,
	readIndependentReviewVerdict,
	type ReviewSubagentLaunch,
	type ReviewSubagentResult,
	type SubagentBootstrapOptions,
	summarizeSubagentExit,
	waitForSubagentReady,
} from "../src/subagent/runner.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "anvil-test-"));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type ReviewBackend = {
	isAvailable(): boolean;
	unavailableMessage(): string;
	createSurface(name: string, signal?: AbortSignal, onCreated?: (surface: string) => void): Promise<string>;
	sendLongCommand(surface: string, command: string, scriptPath: string, signal?: AbortSignal): Promise<void>;
	pollForExit(surface: string, sessionFile: string, signal?: AbortSignal): Promise<SubagentExit>;
	closeSurface(surface: string, signal?: AbortSignal): Promise<void>;
};

type ReviewRunnerTesting = {
	runReviewSubagentWithBackend(
		launch: ReviewSubagentLaunch,
		backend: ReviewBackend,
		signal?: AbortSignal,
		bootstrap?: SubagentBootstrapOptions,
	): Promise<ReviewSubagentResult>;
};

const reviewRunnerTesting = runnerTesting as typeof runnerTesting & ReviewRunnerTesting;

describe("buildSubagentBootstrapCommand", () => {
	it("builds a Pi bootstrap command with session, subagent environment, and sentinel", () => {
		const command = buildSubagentBootstrapCommand({
			cwd: "/repo",
			sessionFile: "/tmp/run/step.jsonl",
		});

		expect(command).toMatch(/^bash -lc "/);
		expect(command).toContain("cd '/repo' && ");
		expect(command).toContain("PI_ANVIL_SUBAGENT_SESSION='/tmp/run/step.jsonl' ");
		expect(command).toMatch(/\bpi\b(?=[^;]*\s--session '\/tmp\/run\/step\.jsonl')/);
		expect(command).toMatch(/\s-e\s+'[^']*src\/index\.ts'/);
		expect(command).not.toContain("@/tmp/run/step.task.md");
		expect(command).toContain("status=\\$?; echo '__ANVIL_SUBAGENT_DONE_'\\\"\\${status}\\\"'__'");
		expect(command).not.toContain("echo '__ANVIL_SUBAGENT_DONE_'$?'__'");
		expect(command).not.toContain("--model");
		expect(command).not.toContain("--thinking");
	});

	it("launches visible interactive Pi instead of print mode", () => {
		const command = buildSubagentBootstrapCommand({
			cwd: "/repo",
			sessionFile: "/tmp/run/step.jsonl",
		});

		expect(command).toMatch(/\bpi\b(?=[^;]*\s--approve\b)(?=[^;]*\s--session\s)/);
		expect(command).not.toMatch(/\s--print\b|\s-p\b/);
		expect(command).toContain("PI_ANVIL_SUBAGENT_SESSION='/tmp/run/step.jsonl'");
		expect(command).toContain("PI_ANVIL_SUBAGENT_MODE='step'");
		expect(command).toContain("status=\\$?");
		expect(command).not.toContain("echo '__ANVIL_SUBAGENT_DONE_'$?'__'");
		expect(command).not.toContain("--continue");
		expect(command).not.toContain("--resume");
	});

	it("passes model and thinking level to the child session", () => {
		const command = buildSubagentBootstrapCommand({
			cwd: "/repo",
			sessionFile: "/tmp/s.jsonl",
			model: "openai-codex/gpt-5.5",
			thinkingLevel: "high",
		});

		expect(command).toContain("--model 'openai-codex/gpt-5.5'");
		expect(command).toContain("--thinking 'high'");
	});

	it("escapes single quotes in paths", () => {
		const command = buildSubagentBootstrapCommand({
			cwd: "/repo/it's here",
			sessionFile: "/tmp/s.jsonl",
		});

		expect(command).toContain("cd '/repo/it'\\\\''s here'");
	});

	it("adds a per-launch nonce to the terminal sentinel", () => {
		const request = { cwd: "/repo", sessionFile: "/tmp/run/step.jsonl" };

		const first = buildSubagentBootstrapCommand(request);
		const second = buildSubagentBootstrapCommand(request);

		expect(first).toContain("__ANVIL_SUBAGENT_DONE_");
		expect(second).toContain("__ANVIL_SUBAGENT_DONE_");
		expect(first).not.toBe(second);
	});

	it("passes a task file as Pi's initial prompt", () => {
		const command = buildSubagentBootstrapCommand({
			cwd: "/repo",
			sessionFile: "/tmp/run/step.jsonl",
			taskFile: "/tmp/run/step.task.md",
		});

		expect(command).toContain("'@/tmp/run/step.task.md'");
	});

	it("keeps normal step subagents eligible for discovered user and project extensions", () => {
		const command = buildSubagentBootstrapCommand({ cwd: "/repo", sessionFile: "/tmp/run/step.jsonl" });

		expect(command).toContain("-e");
		expect(command).toContain("src/index.ts");
		expect(command).toContain("--approve");
		expect(command).not.toContain("--no-extensions");
		expect(command).not.toContain("--no-skills");
		expect(command).not.toContain("env -i");
	});
});

describe("dedicated independent review launcher", () => {
	it("builds a read-only review Pi command with the selected model and thinking level", () => {
		const command = buildReviewSubagentBootstrapCommand({
			cwd: "/repo",
			sessionFile: "/tmp/run/review.jsonl",
			taskFile: "/tmp/run/review.task.md",
			model: "openai-codex/gpt-5.5",
			thinkingLevel: "high",
		});

		expect(command).toMatch(/^\/usr\/bin\/env -i PATH='\/usr\/bin:\/bin' .* \/bin\/bash --noprofile --norc -c /);
		expect(command).toContain(`'${realpathSync(process.execPath)}'`);
		expect(command).toMatch(/'[^']*pi-coding-agent\/dist\/cli\.js' --no-approve\b/);
		expect(command).not.toMatch(/(?:^|[;&|]\s*)pi\s/u);
		expect(command).not.toMatch(/\s--approve\b/);
		expect(command).not.toContain("bash -lc");
		expect(command).toContain("--no-extensions");
		expect(command).toContain("--no-skills");
		expect(command).toContain("--no-prompt-templates");
		expect(command).toContain("--no-themes");
		expect(command).toContain("--no-context-files");
		expect(INDEPENDENT_REVIEW_TOOL_NAMES).toEqual(["read", "grep", "find", "ls", "anvil_verdict"]);
		expect(command).toContain(`--tools ${INDEPENDENT_REVIEW_TOOL_NAMES.join(",")}`);
		expect(command).not.toMatch(/--tools [^;]*(?:bash|edit|write)/);
		expect(command).not.toContain("SSH_AUTH_SOCK");
		expect(command).not.toContain("GITHUB_TOKEN");
		expect(command).not.toContain("DATABASE_URL");
		expect(command).toMatch(/\s-e\s+'[^']*src\/subagent\/child\.ts'/);
		expect(command).toContain("PI_ANVIL_SUBAGENT_SESSION='/tmp/run/review.jsonl'");
		expect(command).toContain("PI_ANVIL_SUBAGENT_MODE='review'");
		expect(command).toContain("PI_ANVIL_REVIEW_ROOT='/repo'");
		expect(command).toContain("--session '/tmp/run/review.jsonl'");
		expect(command).toContain("--model 'openai-codex/gpt-5.5'");
		expect(command).toContain("--thinking 'high'");
		expect(command).toContain("'@/tmp/run/review.task.md'");
		expect(command).not.toContain("src/index.ts");
	});

	it("does not resolve the review Pi executable or shell through inherited PATH", () => {
		const previousPath = process.env.PATH;
		const maliciousDirectory = tempDir();
		process.env.PATH = `${maliciousDirectory}:${previousPath ?? ""}`;
		try {
			const command = buildReviewSubagentBootstrapCommand({
				cwd: "/repo",
				sessionFile: "/tmp/run/review.jsonl",
				model: "openai-codex/gpt-5.5",
			});

			expect(command).not.toContain(maliciousDirectory);
			expect(command).toContain("PATH='/usr/bin:/bin'");
			expect(command).toContain(" /bin/bash --noprofile --norc -c ");
			expect(command).toContain(`'${realpathSync(process.execPath)}'`);
			expect(command).toMatch(/'[^']*pi-coding-agent\/dist\/cli\.js' --no-approve\b/);
		} finally {
			process.env.PATH = previousPath;
		}
	});

	it("isolates auth and cloud credentials to the selected provider allowlist", async () => {
		const sourceAgentDir = tempDir();
		writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({
			"openai-codex": { type: "api_key", key: "$OPENAI_API_KEY" },
			anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" },
		}), "utf8");
		writeFileSync(join(sourceAgentDir, "models.json"), JSON.stringify({
			providers: {
				"openai-codex": { headers: { "OpenAI-Organization": "$OPENAI_ORG_ID" } },
				anthropic: { headers: { "x-unrelated": "$ANTHROPIC_API_KEY" } },
			},
		}), "utf8");
		const originalEnvironment = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			OPENAI_ORG_ID: process.env.OPENAI_ORG_ID,
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
		};
		process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
		process.env.OPENAI_API_KEY = "selected-provider-key";
		process.env.OPENAI_ORG_ID = "selected-provider-org";
		process.env.ANTHROPIC_API_KEY = "unrelated-anthropic-key";
		process.env.AWS_SECRET_ACCESS_KEY = "unrelated-cloud-key";
		let isolatedAgentDir = "";
		let isolatedAuth: unknown;
		let isolatedModels: unknown;
		let sessionFile = "";
		try {
			await reviewRunnerTesting.runReviewSubagentWithBackend(
				{
					name: "Anvil: credential-isolated review",
					task: "Review the artifacts.",
					cwd: process.cwd(),
					runId: `credential-isolation-${Date.now()}`,
					stepId: "implement",
					checkId: expectedReviewCheckId,
					model: "openai-codex/gpt-5.5",
					timeoutMs: 100,
				},
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:credential-isolation",
					sendLongCommand: async (_surface, command) => {
						expect(command).not.toContain("OPENAI_API_KEY");
						expect(command).not.toContain("ANTHROPIC_API_KEY");
						expect(command).not.toContain("AWS_SECRET_ACCESS_KEY");
						isolatedAgentDir = command.match(/PI_CODING_AGENT_DIR='([^']+)'/)?.[1] ?? "";
						sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
						isolatedAuth = JSON.parse(readFileSync(join(isolatedAgentDir, "auth.json"), "utf8"));
						isolatedModels = JSON.parse(readFileSync(join(isolatedAgentDir, "models.json"), "utf8"));
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => {
						await writeIndependentReviewVerdict(sessionFile, {
							checkId: expectedReviewCheckId,
							pass: true,
							reason: "Artifacts satisfy the criteria.",
						});
						return { reason: "done", exitCode: 0 };
					},
					closeSurface: async () => undefined,
				},
				undefined,
				{ readyTimeoutMs: 10, attempts: 1 },
			);
		} finally {
			for (const [name, value] of Object.entries(originalEnvironment)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}

		expect(isolatedAuth).toEqual({
			"openai-codex": {
				type: "api_key",
				key: "$OPENAI_API_KEY",
				env: { OPENAI_API_KEY: "selected-provider-key" },
			},
		});
		expect(JSON.stringify(isolatedAuth)).not.toContain("selected-provider-org");
		expect(isolatedModels).toEqual({
			providers: {
				"openai-codex": { headers: { "OpenAI-Organization": "$OPENAI_ORG_ID" } },
			},
		});
		expect(JSON.stringify(isolatedAuth)).not.toContain("unrelated-anthropic-key");
		expect(JSON.stringify(isolatedAuth)).not.toContain("unrelated-cloud-key");
		expect(existsSync(isolatedAgentDir)).toBe(false);
	});

	it("materializes only selected-provider environment auth when no stored credential exists", () => {
		const sourceAgentDir = tempDir();
		const workDir = tempDir();
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalOpenAiKey = process.env.OPENAI_API_KEY;
		const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
		process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
		process.env.OPENAI_API_KEY = "selected-openai-key";
		process.env.ANTHROPIC_API_KEY = "unrelated-anthropic-key";
		let identity: ReturnType<typeof runnerTesting.prepareReviewIdentity> | undefined;
		try {
			identity = runnerTesting.prepareReviewIdentity(workDir, "openai/gpt-5.4");
			expect(JSON.parse(readFileSync(join(identity.agentDir, "auth.json"), "utf8"))).toEqual({
				openai: {
					type: "api_key",
					key: "$OPENAI_API_KEY",
					env: { OPENAI_API_KEY: "selected-openai-key" },
				},
			});
			expect(existsSync(join(identity.agentDir, "models.json"))).toBe(false);
		} finally {
			runnerTesting.removeReviewIdentity(identity);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalOpenAiKey;
			if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
		}
		expect(existsSync(identity?.agentDir ?? "")).toBe(false);
		expect(() => runnerTesting.prepareReviewIdentity(workDir, "model-without-provider")).toThrow(
			"Independent review requires an explicit provider/model selection.",
		);
	});

	it("preserves only selected OAuth auth and selected model overrides", () => {
		const sourceAgentDir = tempDir();
		const workDir = tempDir();
		writeFileSync(join(sourceAgentDir, "auth.json"), JSON.stringify({
			"github-copilot": { type: "oauth", access: "selected-oauth", refresh: "selected-refresh", expires: 42 },
			anthropic: { type: "api_key", key: "unrelated-key" },
		}), "utf8");
		writeFileSync(join(sourceAgentDir, "models.json"), JSON.stringify({
			modelOverrides: {
				"github-copilot/gpt-5": { name: "Selected override" },
				"openai/gpt-5": { name: "Unrelated override" },
			},
		}), "utf8");
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
		let identity: ReturnType<typeof runnerTesting.prepareReviewIdentity> | undefined;
		try {
			identity = runnerTesting.prepareReviewIdentity(workDir, "github-copilot/gpt-5");
			expect(JSON.parse(readFileSync(join(identity.agentDir, "auth.json"), "utf8"))).toEqual({
				"github-copilot": { type: "oauth", access: "selected-oauth", refresh: "selected-refresh", expires: 42 },
			});
			expect(JSON.parse(readFileSync(join(identity.agentDir, "models.json"), "utf8"))).toEqual({
				modelOverrides: { "github-copilot/gpt-5": { name: "Selected override" } },
			});
		} finally {
			runnerTesting.removeReviewIdentity(identity);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	});

	it("scrubs inherited values before Bash startup hooks can observe them", () => {
		const dir = tempDir();
		const startupMarker = join(dir, "startup-hook-ran");
		const childMarker = join(dir, "child-ran");
		const bashEnv = join(dir, "bash-env");
		const hook = `printf exposed > ${JSON.stringify(startupMarker)}\n`;
		writeFileSync(join(dir, ".bash_profile"), hook, "utf8");
		writeFileSync(bashEnv, hook, "utf8");
		const command = buildReviewSubagentBootstrapCommand({
			cwd: dir,
			sessionFile: join(dir, "review.jsonl"),
			sentinelNonce: "startup-test",
		});
		const launcher = command.slice(0, command.indexOf(" -c ") + " -c ".length);

		execFileSync("/bin/sh", ["-c", `${launcher}'printf ran > ${childMarker}'`], {
			env: {
				...process.env,
				HOME: dir,
				PATH: `${dir}:/usr/bin:/bin`,
				BASH_ENV: bashEnv,
				REVIEW_STARTUP_SECRET: "must-not-reach-child",
			},
			stdio: "pipe",
		});

		expect(existsSync(childMarker)).toBe(true);
		expect(existsSync(startupMarker)).toBe(false);
	});

	it("reports a backend that is unavailable before launch as a typed error", async () => {
		const createSurface = vi.fn(async () => "surface:review");

		await expect(reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: unavailable review",
				task: "Review the artifacts.",
				cwd: "/repo",
				runId: `unavailable-review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
			},
			{
				isAvailable: () => false,
				unavailableMessage: () => "backend disappeared",
				createSurface,
				sendLongCommand: async () => undefined,
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => undefined,
			},
		)).rejects.toBeInstanceOf(ReviewSubagentUnavailableError);
		expect(createSurface).not.toHaveBeenCalled();
	});

	it("canonicalizes the review cwd before launch and confines child tools to that realpath", async () => {
		const parent = tempDir();
		const workspace = join(parent, "workspace");
		const alias = join(parent, "workspace-link");
		mkdirSync(workspace);
		symlinkSync(workspace, alias);
		let commandSent = "";
		let sessionFile = "";

		await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: canonical review",
				task: "Review the artifacts.",
				cwd: alias,
				runId: `canonical-review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
				model: "openai-codex/gpt-5.5",
				timeoutMs: 100,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:canonical-review",
				sendLongCommand: async (_surface, command) => {
					commandSent = command;
					sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					await writeIndependentReviewVerdict(sessionFile, {
						checkId: expectedReviewCheckId,
						pass: true,
						reason: "Artifacts satisfy the criteria.",
					});
					return { reason: "done", exitCode: 0 };
				},
				closeSurface: async () => undefined,
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		const canonical = realpathSync(workspace);
		expect(commandSent).toContain(`cd '${canonical}' &&`);
		expect(commandSent).toContain(`PI_ANVIL_REVIEW_ROOT='${canonical}'`);
		expect(commandSent).not.toContain(`cd '${alias}' &&`);
	});

	it("rejects an unavailable review cwd before creating a backend surface", async () => {
		const createSurface = vi.fn(async () => "surface:invalid-cwd");
		await expect(reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: invalid cwd",
				task: "Review the artifacts.",
				cwd: join(tempDir(), "missing"),
				runId: `invalid-cwd-review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface,
				sendLongCommand: async () => undefined,
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => undefined,
			},
		)).rejects.toThrow("Independent review cwd is unavailable.");
		expect(createSurface).not.toHaveBeenCalled();
	});

	it("rejects a sensitive review cwd before creating a backend surface", async () => {
		const sensitiveCwd = join(tempDir(), ".ssh");
		mkdirSync(sensitiveCwd);
		const createSurface = vi.fn(async () => "surface:sensitive-cwd");
		await expect(reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: sensitive cwd",
				task: "Review the artifacts.",
				cwd: sensitiveCwd,
				runId: `sensitive-cwd-review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface,
				sendLongCommand: async () => undefined,
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => undefined,
			},
		)).rejects.toThrow("Independent review cwd is unavailable.");
		expect(createSurface).not.toHaveBeenCalled();
	});

	it("reports a backend that disappears during surface launch as a typed unavailable error", async () => {
		let available = true;
		const createSurface = vi.fn(async () => {
			available = false;
			throw new Error("provider-controlled launch details");
		});

		const error = await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: disappearing review",
				task: "Review the artifacts.",
				cwd: process.cwd(),
				runId: `disappearing-review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
				model: "openai-codex/gpt-5.5",
			},
			{
				isAvailable: () => available,
				unavailableMessage: () => "backend is no longer available",
				createSurface,
				sendLongCommand: async () => undefined,
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => undefined,
			},
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ReviewSubagentUnavailableError);
		expect((error as Error).message).toBe("Independent review backend is unavailable. backend is no longer available");
		expect((error as Error).message).not.toContain("provider-controlled launch details");
		expect(createSurface).toHaveBeenCalledOnce();
	});

	it.each(["backend launch", "command launch", "completion wait"] as const)(
		"omits raw diagnostics when review %s fails",
		async (failedPhase) => {
			const secret = "OPENAI_API_KEY=must-not-persist";
			let sessionFile: string | undefined;
			const closeSurface = vi.fn(async () => undefined);
			const error = await reviewRunnerTesting
				.runReviewSubagentWithBackend(
					{
						name: "Anvil: diagnostic-safe review",
						task: "Review the artifacts.",
						cwd: process.cwd(),
						runId: `diagnostic-safe-review-${Date.now()}-${failedPhase.replace(" ", "-")}`,
						stepId: "implement",
						checkId: expectedReviewCheckId,
						model: "openai-codex/gpt-5.5",
						timeoutMs: 100,
					},
					{
						isAvailable: () => true,
						unavailableMessage: () => "unavailable",
						createSurface: async () => {
							if (failedPhase === "backend launch") throw new Error(secret);
							return "surface:diagnostic-safe-review";
						},
						sendLongCommand: async (_surface, command) => {
							if (failedPhase === "command launch") throw new Error(secret);
							sessionFile = command.match(/--session '([^']+)'/)?.[1];
							if (!sessionFile) throw new Error("missing session file");
							writeSubagentReadySidecar(sessionFile);
						},
						pollForExit: async () => {
							throw new Error(secret);
						},
						closeSurface,
					},
					undefined,
					{ readyTimeoutMs: 10, attempts: 1 },
				)
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(`Independent review subagent ${failedPhase} failed; details omitted.`);
			expect((error as Error).message).not.toContain(secret);
			if (failedPhase === "backend launch") expect(closeSurface).not.toHaveBeenCalled();
			else expect(closeSurface).toHaveBeenCalledWith("surface:diagnostic-safe-review", expect.any(AbortSignal));
		},
	);

	it("executes a review through the configured backend surface and returns its sidecar verdict", async () => {
		let commandSent: string | undefined;
		let sessionFile: string | undefined;
		let surfaceClosed = false;
		const result = await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: review",
				task: "Review the artifacts.",
				cwd: process.cwd(),
				runId: `review-${Date.now()}`,
				stepId: "implement",
				checkId: expectedReviewCheckId,
				model: "openai-codex/gpt-5.5",
				thinkingLevel: "high",
				timeoutMs: 100,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:review",
				sendLongCommand: async (_surface, command) => {
					commandSent = command;
					sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					if (!sessionFile) throw new Error("missing session file");
					await writeIndependentReviewVerdict(sessionFile, {
						checkId: expectedReviewCheckId,
						pass: false,
						reason: "The required artifact is missing.",
					});
					return { reason: "done", exitCode: 0 };
				},
				closeSurface: async () => {
					surfaceClosed = true;
				},
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		expect(commandSent).toContain("--no-extensions");
		expect(commandSent).toContain("--model 'openai-codex/gpt-5.5'");
		expect(commandSent).toContain("--thinking 'high'");
		expect(surfaceClosed).toBe(true);
		expect(result).toMatchObject({
			checkId: expectedReviewCheckId,
			pass: false,
			reason: INDEPENDENT_REVIEW_FAIL_REASON,
			sessionFile,
			exitCode: 0,
		});
	});

	it("bounds and sanitizes launcher identities for a multi-megabyte control-containing step id", async () => {
		const hostileStepId = `${"review\u0000\n\u001b[31m".repeat(150_000)}STEP_ID_CANARY`;
		const checkId = normalizeIndependentReviewIdentity(`run:${hostileStepId}:0:0`);
		let surfaceName = "";
		let sessionFile = "";
		let scriptPath = "";

		const result = await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: `Anvil review: ${hostileStepId}`,
				task: `Submit anvil_verdict for ${checkId}.`,
				cwd: process.cwd(),
				runId: "bounded-review-run",
				stepId: hostileStepId,
				checkId,
				model: "openai-codex/gpt-5.5",
				timeoutMs: 100,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async (name) => {
					surfaceName = name;
					return "surface:bounded-review";
				},
				sendLongCommand: async (_surface, command, receivedScriptPath) => {
					scriptPath = receivedScriptPath;
					sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					await writeIndependentReviewVerdict(sessionFile, {
						checkId,
						pass: true,
						reason: "Artifacts satisfy the criteria.",
					});
					return { reason: "done", exitCode: 0 };
				},
				closeSurface: async () => undefined,
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		expect(result).toMatchObject({ checkId, pass: true, exitCode: 0 });
		expect(Buffer.byteLength(surfaceName, "utf8")).toBeLessThanOrEqual(256);
		expect(surfaceName).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(surfaceName).not.toMatch(/[\u0000-\u001f\u007f]/u);
		for (const path of [sessionFile, scriptPath]) {
			expect(Buffer.byteLength(path, "utf8")).toBeLessThan(1024);
			expect(path).not.toContain("STEP_ID_CANARY");
			expect(path).not.toMatch(/[\u0000-\u001f\u007f]/u);
		}
	});

	it("bounds complete review task and session basenames for a 256-byte safe step id", async () => {
		const stepId = "s".repeat(256);
		const generatedPaths: string[] = [];
		let sessionFile = "";

		const result = await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: maximum safe review identity",
				task: `Submit anvil_verdict for ${expectedReviewCheckId}.`,
				cwd: process.cwd(),
				runId: "maximum-safe-review-identity",
				stepId,
				checkId: expectedReviewCheckId,
				model: "openai-codex/gpt-5.5",
				timeoutMs: 100,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:maximum-safe-review-identity",
				sendLongCommand: async (_surface, command, scriptPath) => {
					sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
					const taskFile = command.match(/'@([^']+)'/)?.[1] ?? "";
					if (!sessionFile || !taskFile) throw new Error("missing generated review path");
					generatedPaths.push(taskFile, sessionFile, scriptPath, `${sessionFile}.ready`, `${sessionFile}.verdict.json`);
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					await writeIndependentReviewVerdict(sessionFile, {
						checkId: expectedReviewCheckId,
						pass: true,
						reason: "Artifacts satisfy the criteria.",
					});
					return { reason: "done", exitCode: 0 };
				},
				closeSurface: async () => undefined,
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		expect(result).toMatchObject({ checkId: expectedReviewCheckId, pass: true, exitCode: 0 });
		expect(generatedPaths).toHaveLength(5);
		for (const path of generatedPaths) expect(Buffer.byteLength(basename(path), "utf8")).toBeLessThanOrEqual(255);
	});

	it("completes a review with a 256-byte run id and bounds every actual lifecycle basename", async () => {
		const runId = "r".repeat(256);
		const stepId = "s".repeat(180);
		const generatedPaths = new Set<string>();
		const temporaryPaths = new Set<string>();
		const captureTemporaryPath = (path: string) => temporaryPaths.add(path);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		let sessionFile = "";

		try {
			const result = await reviewRunnerTesting.runReviewSubagentWithBackend(
				{
					name: "Anvil: near-limit atomic review",
					task: `Submit anvil_verdict for ${expectedReviewCheckId}.`,
					cwd: process.cwd(),
					runId,
					stepId,
					checkId: expectedReviewCheckId,
					model: "openai-codex/gpt-5.5",
					timeoutMs: 100,
				},
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:near-limit-atomic-review",
					sendLongCommand: async (_surface, command, scriptPath) => {
						sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
						const taskFile = command.match(/'@([^']+)'/)?.[1] ?? "";
						if (!sessionFile || !taskFile) throw new Error("missing generated review path");
						const sidecars = [`${sessionFile}.ready`, `${sessionFile}.exit`, `${sessionFile}.verdict.json`];
						for (const path of [taskFile, sessionFile, scriptPath, ...sidecars]) generatedPaths.add(path);
						writeSubagentReadySidecar(sessionFile, captureTemporaryPath);
					},
					pollForExit: async () => {
						writeSubagentExitSidecar(sessionFile, undefined, captureTemporaryPath);
						await writeIndependentReviewVerdict(sessionFile, {
							checkId: expectedReviewCheckId,
							pass: true,
							reason: "Artifacts satisfy the criteria.",
						}, captureTemporaryPath);
						return { reason: "done", exitCode: 0 };
					},
					closeSurface: async () => undefined,
				},
				undefined,
				{ readyTimeoutMs: 10, attempts: 1 },
			);

			expect(result).toMatchObject({ checkId: expectedReviewCheckId, pass: true, exitCode: 0 });
			expect(basename(sessionFile).startsWith(stepId)).toBe(true);
			expect(temporaryPaths).toHaveLength(2);
			expect(basename(dirname(sessionFile))).toMatch(/^sha256-[a-f0-9]{64}$/u);
			expect(Buffer.byteLength(basename(dirname(sessionFile)), "utf8")).toBeLessThanOrEqual(255);
			for (const path of [...generatedPaths, ...temporaryPaths]) {
				expect(Buffer.byteLength(basename(path), "utf8"), path).toBeLessThanOrEqual(255);
			}
		} finally {
			now.mockRestore();
			if (sessionFile) rmSync(dirname(sessionFile), { recursive: true, force: true });
		}
	});

	it("does not let a path-shaped review run id escape the session root", async () => {
		let sessionFile = "";
		const result = await reviewRunnerTesting.runReviewSubagentWithBackend(
			{
				name: "Anvil: path-confined review",
				task: `Submit anvil_verdict for ${expectedReviewCheckId}.`,
				cwd: process.cwd(),
				runId: "../../REVIEW_PATH_ESCAPE",
				stepId: "implement/path",
				checkId: expectedReviewCheckId,
				model: "openai-codex/gpt-5.5",
				timeoutMs: 100,
			},
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:path-confined-review",
				sendLongCommand: async (_surface, command) => {
					sessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					await writeIndependentReviewVerdict(sessionFile, {
						checkId: expectedReviewCheckId,
						pass: true,
						reason: "Artifacts satisfy the criteria.",
					});
					return { reason: "done", exitCode: 0 };
				},
				closeSurface: async () => undefined,
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		expect(result.pass).toBe(true);
		expect(sessionFile).toMatch(/[/\\]anvil[/\\]sha256-[a-f0-9]{64}[/\\]sha256-[a-f0-9]{64}-/u);
		expect(sessionFile).not.toContain("REVIEW_PATH_ESCAPE");
	});

	it("uses distinct session and sidecar paths for concurrent reviews of the same step", async () => {
		const sessions = new Map<string, string>();
		let surfaceIndex = 0;
		const backend = {
			isAvailable: () => true,
			unavailableMessage: () => "unavailable",
			createSurface: async () => `surface:concurrent-${surfaceIndex++}`,
			sendLongCommand: async (surface: string, command: string) => {
				const sessionFile = command.match(/--session '([^']+)'/)?.[1];
				if (!sessionFile) throw new Error("missing session file");
				sessions.set(surface, sessionFile);
				writeSubagentReadySidecar(sessionFile);
			},
			pollForExit: async (surface: string) => {
				const sessionFile = sessions.get(surface);
				if (!sessionFile) throw new Error("missing session file");
				await writeIndependentReviewVerdict(sessionFile, {
					checkId: expectedReviewCheckId,
					pass: true,
					reason: "Artifacts satisfy the criteria.",
				});
				return { reason: "done" as const, exitCode: 0 };
			},
			closeSurface: async () => undefined,
		};
		const launch = {
			name: "Anvil: concurrent review",
			task: "Review the artifacts.",
			cwd: process.cwd(),
			runId: `concurrent-review-${Date.now()}`,
			stepId: "for-each-review",
			checkId: expectedReviewCheckId,
			model: "openai-codex/gpt-5.5",
			timeoutMs: 100,
		};
		const now = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
		try {
			const results = await Promise.all([
				reviewRunnerTesting.runReviewSubagentWithBackend(launch, backend, undefined, { readyTimeoutMs: 10, attempts: 1 }),
				reviewRunnerTesting.runReviewSubagentWithBackend(launch, backend, undefined, { readyTimeoutMs: 10, attempts: 1 }),
			]);
			const sessionFiles = results.map((result) => result.sessionFile);
			expect(new Set(sessionFiles).size).toBe(2);
			expect(sessionFiles.every((path) => path && existsSync(`${path}.verdict.json`))).toBe(true);
			expect(results).toEqual(expect.arrayContaining([
				expect.objectContaining({ pass: true, checkId: expectedReviewCheckId }),
			]));
		} finally {
			now.mockRestore();
		}
	});

	it("rejects a completed review session that never writes a verdict sidecar", async () => {
		await expect(
			reviewRunnerTesting.runReviewSubagentWithBackend(
				{
					name: "Anvil: missing verdict",
					task: "Review the artifacts.",
					cwd: process.cwd(),
					runId: `missing-review-${Date.now()}`,
					stepId: "implement",
					checkId: expectedReviewCheckId,
					model: "openai-codex/gpt-5.5",
					timeoutMs: 100,
				},
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:missing-review",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => ({ reason: "done", exitCode: 0 }),
					closeSurface: async () => undefined,
				},
				undefined,
				{ readyTimeoutMs: 10, attempts: 1 },
			),
		).rejects.toThrow(/missing.*verdict/i);
	});

	it("sanitizes a non-zero review child exit and closes its surface", async () => {
		const secret = "API_TOKEN=do-not-persist";
		let surfaceClosed = false;
		const error = await reviewRunnerTesting
			.runReviewSubagentWithBackend(
				{
					name: "Anvil: failed review",
					task: "Review the artifacts.",
					cwd: process.cwd(),
					runId: `failed-review-${Date.now()}`,
					stepId: "implement",
					checkId: expectedReviewCheckId,
					model: "openai-codex/gpt-5.5",
					timeoutMs: 100,
				},
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:failed-review",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => ({ reason: "sentinel", exitCode: 17, errorMessage: `Child failed: ${secret}` }),
					closeSurface: async () => {
						surfaceClosed = true;
					},
				},
				undefined,
				{ readyTimeoutMs: 10, attempts: 1 },
			)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Independent review subagent exited with code 17; failure details omitted.");
		expect((error as Error).message).not.toContain(secret);
		expect(surfaceClosed).toBe(true);
	});

	it("sanitizes exhausted review transport failures and cleans up the surface", async () => {
		const secret = "DATABASE_URL=do-not-persist";
		let surfaceClosed = false;
		const error = await reviewRunnerTesting
			.runReviewSubagentWithBackend(
				{
					name: "Anvil: review transport failure",
					task: "Review the artifacts.",
					cwd: process.cwd(),
					runId: `review-transport-${Date.now()}`,
					stepId: "implement",
					checkId: expectedReviewCheckId,
					model: "openai-codex/gpt-5.5",
					timeoutMs: 100,
				},
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:review-transport",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
						writeFileSync(
							sessionFile,
							JSON.stringify({
								type: "message",
								message: { role: "assistant", content: [{ type: "text", text: secret }] },
								diagnostics: [{ type: "provider_transport_failure" }],
							}),
							"utf8",
						);
					},
					pollForExit: async () => ({ reason: "error", exitCode: 1, errorMessage: `Provider failed: ${secret}` }),
					closeSurface: async () => {
						surfaceClosed = true;
					},
				},
				undefined,
				{ readyTimeoutMs: 10, attempts: 1, transportFailureLimit: 1 },
			)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Subagent encountered 1 provider transport failures within 5 minutes.");
		expect((error as Error).message).not.toContain(secret);
		expect(surfaceClosed).toBe(true);
	});
});

describe("independent review filesystem confinement", () => {
	it("overrides every allowlisted filesystem tool with the confined implementation", async () => {
		const workspace = tempDir();
		writeFileSync(join(workspace, "artifact.txt"), "reviewable", "utf8");
		const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		registerReviewFilesystemTools({ registerTool: (tool: any) => tools.push(tool) } as any, workspace);

		expect(tools.map((tool) => tool.name).sort()).toEqual([...INDEPENDENT_REVIEW_TOOL_NAMES.slice(0, -1)].sort());
		const read = tools.find((tool) => tool.name === "read")!;
		const result = await read.execute("call", { path: "artifact.txt" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "1: reviewable" }],
			details: { confined: true },
		});
	});

	it("resolves the workspace root and exposes bounded read-only artifact inspection", async () => {
		const parent = tempDir();
		const workspace = join(parent, "workspace");
		const alias = join(parent, "workspace-link");
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "feature.ts"), "export const status = 'ready';\n", "utf8");
		symlinkSync(workspace, alias);

		const filesystem = await ReviewFileSystem.create(alias);

		expect(filesystem.root).toBe(realpathSync(workspace));
		expect(await filesystem.read("src/feature.ts")).toContain("1: export const status = 'ready';");
		expect(await filesystem.ls("src")).toBe("feature.ts");
		expect(await filesystem.find("*.ts")).toBe("src/feature.ts");
		expect(await filesystem.grep("status", { path: "src", glob: "*.ts" })).toContain("src/feature.ts:1:");
	});

	it("denies absolute, parent-relative, and symlink paths outside the canonical cwd", async () => {
		const parent = tempDir();
		const workspace = join(parent, "workspace");
		const outside = join(parent, "private");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(join(outside, "private.txt"), "PRIVATE_FILE_CONTENT", "utf8");
		symlinkSync(outside, join(workspace, "escape"));
		const filesystem = await ReviewFileSystem.create(workspace);

		for (const path of ["../private/private.txt", join(outside, "private.txt"), "escape/private.txt"]) {
			const error = await filesystem.read(path).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ReviewFileAccessError);
			expect((error as Error).message).not.toContain("PRIVATE_FILE_CONTENT");
			expect((error as Error).message).not.toContain("private.txt");
		}
		expect(await filesystem.find("*private*")).toBe("No matching paths.");
		expect(await filesystem.grep("PRIVATE_FILE_CONTENT")).toBe("No matches.");
	});

	it("validates opened files and enumerates directories through stable descriptor aliases", async () => {
		const workspace = tempDir();
		const outside = tempDir();
		const outsideFile = join(outside, "artifact.txt");
		writeFileSync(outsideFile, "must not be read", "utf8");
		const handle = await open(outsideFile, "r");

		try {
			await expect(validateOpenedHandle(realpathSync(workspace), handle)).rejects.toBeInstanceOf(ReviewFileAccessError);
		} finally {
			await handle.close();
		}

		expect(reviewFsTesting.directoryDescriptorPath(42, "linux")).toBe("/proc/self/fd/42");
		expect(() => reviewFsTesting.directoryDescriptorPath(42, "darwin")).toThrow("Secure review directory access is unavailable");
		expect(() => reviewFsTesting.directoryDescriptorPath(42, "win32")).toThrow("Secure review directory access is unavailable");
	});

	it("does not enumerate an external directory swapped into a validated pathname", async () => {
		const workspace = tempDir();
		const reviewedDirectory = join(workspace, "artifacts");
		const openedDirectory = join(workspace, "opened-artifacts");
		const outside = tempDir();
		mkdirSync(reviewedDirectory);
		writeFileSync(join(reviewedDirectory, "safe.txt"), "safe", "utf8");
		writeFileSync(join(outside, "private.txt"), "PRIVATE_FILE_CONTENT", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);
		let swapped = false;
		reviewFsTesting.setBeforeDirectoryEnumeration(() => {
			if (swapped) return;
			swapped = true;
			renameSync(reviewedDirectory, openedDirectory);
			symlinkSync(outside, reviewedDirectory);
		});

		try {
			expect(await filesystem.ls("artifacts")).toBe("safe.txt");
		} finally {
			reviewFsTesting.setBeforeDirectoryEnumeration(undefined);
			if (swapped) {
				rmSync(reviewedDirectory);
				renameSync(openedDirectory, reviewedDirectory);
			}
		}
	});

	it("blocks secret-like files and directories from direct and recursive reads", async () => {
		const workspace = tempDir();
		mkdirSync(join(workspace, ".ssh"));
		writeFileSync(join(workspace, ".env"), "API_KEY=must-not-persist", "utf8");
		writeFileSync(join(workspace, ".envrc"), "export API_TOKEN=must-not-persist", "utf8");
		writeFileSync(join(workspace, ".envrc.local"), "export PRIVATE_KEY=must-not-persist", "utf8");
		writeFileSync(join(workspace, "credentials.json"), "{\"token\":\"must-not-persist\"}", "utf8");
		writeFileSync(join(workspace, ".ssh", "id_ed25519"), "must-not-persist", "utf8");
		writeFileSync(join(workspace, "public.txt"), "safe artifact", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		await expect(filesystem.read(".env")).rejects.toBeInstanceOf(ReviewFileAccessError);
		await expect(filesystem.read(".envrc")).rejects.toBeInstanceOf(ReviewFileAccessError);
		await expect(filesystem.read(".envrc.local")).rejects.toBeInstanceOf(ReviewFileAccessError);
		await expect(filesystem.read("credentials.json")).rejects.toBeInstanceOf(ReviewFileAccessError);
		await expect(filesystem.read(".ssh/id_ed25519")).rejects.toBeInstanceOf(ReviewFileAccessError);
		expect(await filesystem.ls()).toBe("public.txt");
		expect(await filesystem.find("*")).toBe("public.txt");
		expect(await filesystem.grep("must-not-persist")).toBe("No matches.");
	});

	it("rejects sensitive workflow roots instead of treating them as safe relative roots", async () => {
		const parent = tempDir();
		const sensitiveDirectory = join(parent, ".ssh");
		const nestedSensitiveDirectory = join(parent, "secrets", "project");
		mkdirSync(sensitiveDirectory, { recursive: true });
		mkdirSync(nestedSensitiveDirectory, { recursive: true });
		writeFileSync(join(sensitiveDirectory, "config"), "PRIVATE_ROOT_CONTENT", "utf8");

		await expect(ReviewFileSystem.create(sensitiveDirectory)).rejects.toBeInstanceOf(ReviewFileAccessError);
		await expect(ReviewFileSystem.create(nestedSensitiveDirectory)).rejects.toBeInstanceOf(ReviewFileAccessError);
	});

	it("rejects missing, non-directory, binary, and non-UTF-8 review inputs", async () => {
		const workspace = tempDir();
		const regularFile = join(workspace, "file.txt");
		writeFileSync(regularFile, "text", "utf8");
		await expect(ReviewFileSystem.create(join(workspace, "missing"))).rejects.toThrow("cwd is unavailable");
		await expect(ReviewFileSystem.create(regularFile)).rejects.toBeInstanceOf(ReviewFileAccessError);

		const filesystem = await ReviewFileSystem.create(workspace);
		writeFileSync(join(workspace, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
		writeFileSync(join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
		await expect(filesystem.read(".")).rejects.toThrow("regular file");
		await expect(filesystem.ls("file.txt")).rejects.toThrow("directory");
		await expect(filesystem.read("binary.bin")).rejects.toThrow("Binary files");
		await expect(filesystem.read("invalid.txt")).rejects.toThrow("Non-UTF-8");
	});

	it("bounds file reads, line ranges, search results, and persisted tool output", async () => {
		const workspace = tempDir();
		const manyLines = Array.from({ length: 600 }, (_, index) => `MATCH ${index} ${"x".repeat(1_100)}`).join("\n");
		writeFileSync(join(workspace, "large.txt"), `${manyLines}${"z".repeat(MAX_REVIEW_READ_BYTES)}`, "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		const ranged = await filesystem.read("large.txt", { offset: 2, limit: 1 });
		expect(ranged).toMatch(/^2: MATCH 1/u);
		expect(ranged).toContain("…");
		const grep = await filesystem.grep("match", { ignoreCase: true, limit: 500 });
		expect(Buffer.byteLength(grep, "utf8")).toBeLessThanOrEqual(MAX_REVIEW_TOOL_OUTPUT_BYTES);
		expect(grep).toContain("[Output truncated]");
	});

	it("validates find and grep inputs and supports direct-file filtering", async () => {
		const workspace = tempDir();
		writeFileSync(join(workspace, "artifact.ts"), "export const READY = true;\n", "utf8");
		writeFileSync(join(workspace, "artifact.md"), "READY\n", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		await expect(filesystem.find("*.ts", { path: "artifact.ts" })).rejects.toThrow("directory");
		await expect(filesystem.find("bad\npattern")).rejects.toThrow("pattern is invalid");
		await expect(filesystem.grep("bad\npattern")).rejects.toThrow("pattern is invalid");
		expect(await filesystem.grep("READY", { path: "artifact.ts" })).toContain("artifact.ts:1:");
		expect(await filesystem.grep("READY", { glob: "*.json" })).toBe("No matches.");
		expect(await filesystem.find("artifact.?s")).toBe("artifact.ts");
	});

	it("returns deterministic path-ordered grep results when limited", async () => {
		const workspace = tempDir();
		mkdirSync(join(workspace, "z-directory"));
		mkdirSync(join(workspace, "a-directory"));
		writeFileSync(join(workspace, "z-directory", "match.txt"), "LIMITED_MATCH z\n", "utf8");
		writeFileSync(join(workspace, "a-directory", "z-match.txt"), "LIMITED_MATCH az\n", "utf8");
		writeFileSync(join(workspace, "a-directory", "a-match.txt"), "LIMITED_MATCH aa\n", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		const expected = "a-directory/a-match.txt:1:LIMITED_MATCH aa\n" +
			"a-directory/z-match.txt:1:LIMITED_MATCH az";
		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(await filesystem.grep("LIMITED_MATCH", { limit: 2 })).toBe(expected);
		}
	});

	it("handles adversarial wildcard patterns without regex backtracking", async () => {
		const workspace = tempDir();
		writeFileSync(join(workspace, "artifact.ts"), "safe\n", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		expect(await filesystem.find(`${"*".repeat(900)}never`)).toBe("No matching paths.");
	});

	it("stops grep after its aggregate read budget", async () => {
		const workspace = tempDir();
		const chunk = Buffer.alloc(MAX_REVIEW_READ_BYTES, "a");
		for (let index = 0; index < MAX_REVIEW_SEARCH_BYTES / MAX_REVIEW_READ_BYTES; index += 1) {
			writeFileSync(join(workspace, `artifact-${String(index).padStart(3, "0")}.txt`), chunk);
		}
		writeFileSync(join(workspace, "z-target.txt"), "MUST_NOT_BE_SCANNED\n", "utf8");
		const filesystem = await ReviewFileSystem.create(workspace);

		expect(await filesystem.grep("MUST_NOT_BE_SCANNED")).toBe("No matches.");
	}, 15_000);

	it("fails public find and grep instead of returning partial traversal-limit results", async () => {
		const workspace = tempDir();
		for (let index = 0; index <= MAX_REVIEW_DIRECTORY_ENTRIES; index += 1) {
			mkdirSync(join(workspace, `directory-${index}`));
		}
		const filesystem = await ReviewFileSystem.create(workspace);

		await expect(filesystem.find("never-matches")).rejects.toThrow(/traversal.*limit/i);
		await expect(filesystem.grep("never-matches")).rejects.toThrow(/traversal.*limit/i);
	}, 30_000);

	it("shares Darwin helper launches and buffered entries across one traversal budget", () => {
		const budget = reviewFsTesting.createTraversalBudget();
		const grants: number[] = [];
		for (let index = 0; index < MAX_DARWIN_DIRECTORY_SUBPROCESSES; index += 1) {
			grants.push(budget.claimDarwinDirectorySubprocess());
		}

		expect(grants.every((grant) => grant <= MAX_DARWIN_DIRECTORY_ENTRIES_PER_SUBPROCESS)).toBe(true);
		expect(grants.reduce((total, grant) => total + grant, 0)).toBe(MAX_REVIEW_DIRECTORY_ENTRIES);
		expect(budget.claimedDarwinDirectoryEntries).toBe(MAX_REVIEW_DIRECTORY_ENTRIES);
		expect(budget.claimedDarwinDirectorySubprocesses).toBe(MAX_DARWIN_DIRECTORY_SUBPROCESSES);
		expect(() => budget.claimDarwinDirectorySubprocess()).toThrow(/subprocess limit/i);
	});

	it("rejects Darwin descriptor validation cancelled before launch", async () => {
		const preCancelled = new AbortController();
		preCancelled.abort();
		await expect(
			reviewFsTesting.resolveDarwinOpenedHandlePath(120, preCancelled.signal),
		).rejects.toThrow("cancelled");

		const queuedCancellation = new AbortController();
		const executor = vi.fn(async () => ({ stdout: "" }));
		reviewFsTesting.setDarwinDescriptorExecutor(executor);
		try {
			const validation = reviewFsTesting.resolveDarwinOpenedHandlePath(121, queuedCancellation.signal);
			queuedCancellation.abort();
			await expect(validation).rejects.toThrow("cancelled");
			await delay(10);
			expect(executor).not.toHaveBeenCalled();
		} finally {
			reviewFsTesting.resetDarwinDescriptorExecutor();
		}
	});

	it("parses a successful batched Darwin lsof snapshot", async () => {
		const workspace = tempDir();
		const artifact = join(workspace, "artifact.txt");
		writeFileSync(artifact, "safe", "utf8");
		const executor = vi.fn(async () => ({ stdout: `f122\nn${artifact}\nf123\nn${artifact}\n` }));
		reviewFsTesting.setDarwinDescriptorExecutor(executor);
		try {
			await expect(Promise.all([
				reviewFsTesting.resolveDarwinOpenedHandlePath(122),
				reviewFsTesting.resolveDarwinOpenedHandlePath(123),
			])).resolves.toEqual([realpathSync(artifact), realpathSync(artifact)]);
			expect(executor).toHaveBeenCalledOnce();
			expect(executor.mock.calls[0]?.[1]).toContain("122,123");
		} finally {
			reviewFsTesting.resetDarwinDescriptorExecutor();
		}
	});

	it("bounds and cancels Darwin lsof descriptor validation", async () => {
		const controller = new AbortController();
		let receivedOptions: {
			killSignal: "SIGKILL";
			signal: AbortSignal;
			timeout: number;
		} | undefined;
		reviewFsTesting.setDarwinDescriptorExecutor((_file, _args, options) => {
			receivedOptions = options;
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
			});
		});

		try {
			const validation = reviewFsTesting.resolveDarwinOpenedHandlePath(123, controller.signal);
			await vi.waitFor(() => expect(receivedOptions).toBeDefined());
			expect(receivedOptions).toMatchObject({
				killSignal: "SIGKILL",
				timeout: DARWIN_DESCRIPTOR_VALIDATION_TIMEOUT_MS,
			});

			controller.abort();
			await expect(validation).rejects.toThrow("cancelled");
			expect(receivedOptions?.signal.aborted).toBe(true);
		} finally {
			reviewFsTesting.resetDarwinDescriptorExecutor();
		}
	});

	it("batches Darwin descriptor validation for large reviews", async () => {
		if (process.platform !== "darwin") return;
		const workspace = tempDir();
		for (let index = 0; index < 96; index += 1) {
			writeFileSync(join(workspace, `artifact-${index}.txt`), `REVIEW_MATCH ${index}\n`, "utf8");
		}
		const filesystem = await ReviewFileSystem.create(workspace);
		reviewFsTesting.resetDarwinDescriptorValidationSpawnCount();

		const matches = await filesystem.grep("REVIEW_MATCH", { limit: 200 });

		expect(matches.split("\n")).toHaveLength(96);
		expect(reviewFsTesting.getDarwinDescriptorValidationSpawnCount()).toBeLessThanOrEqual(4);
	}, 10_000);
});

describe("subagent bootstrap readiness", () => {
	it("waits for the child readiness marker", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		writeSubagentReadySidecar(sessionFile);

		await expect(waitForSubagentReady(sessionFile, 10)).resolves.toBeUndefined();
	});

	it("launches the task as Pi's initial prompt", async () => {
		const calls: string[] = [];
		let bootstrapCommand = "";
		await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: ready", task: "inspect", cwd: "/repo", runId: `ready-${Date.now()}`, stepId: "ready", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:1",
				sendLongCommand: async (_surface, command) => {
					bootstrapCommand = command;
					calls.push("bootstrap");
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => calls.push("close"),
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1 },
		);

		expect(calls).toEqual(["bootstrap", "close"]);
		expect(bootstrapCommand).toMatch(/'@[^']+\.task\.md'/);
	});

	it("bounds and cancels a hanging surface launch", async () => {
		let launchSignal: AbortSignal | undefined;
		const startedAt = Date.now();
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: hung launch", task: "inspect", cwd: "/repo", runId: `hung-launch-${Date.now()}`, stepId: "hung", timeoutMs: 20 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async (_name, signal) => {
						launchSignal = signal;
						return new Promise<string>(() => {});
					},
					sendLongCommand: async () => {},
					pollForExit: async () => ({ reason: "done", exitCode: 0 }),
					closeSurface: async () => {},
				},
				undefined,
				{ attempts: 1 },
			),
		).rejects.toThrow(/timed out after 20ms/i);

		expect(launchSignal?.aborted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(500);
	});

	it("bounds and cancels a hanging command dispatch", async () => {
		let dispatchSignal: AbortSignal | undefined;
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: hung dispatch", task: "inspect", cwd: "/repo", runId: `hung-dispatch-${Date.now()}`, stepId: "hung", timeoutMs: 20 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:1",
					sendLongCommand: async (_surface, _command, _script, signal) => {
						dispatchSignal = signal;
						return new Promise<void>(() => {});
					},
					pollForExit: async () => ({ reason: "done", exitCode: 0 }),
					closeSurface: async () => {},
				},
				undefined,
				{ attempts: 1 },
			),
		).rejects.toThrow(/timed out after 20ms/i);

		expect(dispatchSignal?.aborted).toBe(true);
	});

	it("does not let hanging surface cleanup bypass the workflow deadline", async () => {
		let cleanupSignal: AbortSignal | undefined;
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: hung cleanup", task: "inspect", cwd: "/repo", runId: `hung-cleanup-${Date.now()}`, stepId: "hung", timeoutMs: 30 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:1",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => ({ reason: "done", exitCode: 0 }),
					closeSurface: async (_surface, signal) => {
						cleanupSignal = signal;
						return new Promise<void>(() => {});
					},
				},
				undefined,
				{ readyTimeoutMs: 5, attempts: 1, cleanupTimeoutMs: 10 },
			),
		).resolves.toMatchObject({ exitCode: 0 });

		expect(cleanupSignal?.aborted).toBe(true);
	});

	it("cleans up with an independent signal after workflow cancellation", async () => {
		const controller = new AbortController();
		let cleanupStartedAborted: boolean | undefined;
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: cancelled cleanup", task: "inspect", cwd: "/repo", runId: `cancelled-cleanup-${Date.now()}`, stepId: "cancelled", timeoutMs: 100 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:cancelled",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => {
						controller.abort();
						throw new Error("poll cancelled");
					},
					closeSurface: async (_surface, cleanup) => {
						cleanupStartedAborted = cleanup?.aborted;
					},
				},
				controller.signal,
				{ readyTimeoutMs: 10, attempts: 1, cleanupTimeoutMs: 20 },
			),
		).rejects.toThrow("poll cancelled");

		expect(controller.signal.aborted).toBe(true);
		expect(cleanupStartedAborted).toBe(false);
	});

	it("cleans up after the workflow deadline has elapsed", async () => {
		let closed = false;
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: expired cleanup", task: "inspect", cwd: "/repo", runId: `expired-cleanup-${Date.now()}`, stepId: "expired", timeoutMs: 15 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async () => "surface:expired",
					sendLongCommand: async (_surface, command) => {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					},
					pollForExit: async () => {
						await delay(20);
						throw new Error("poll timed out");
					},
					closeSurface: async () => {
						closed = true;
					},
				},
				undefined,
				{ readyTimeoutMs: 5, attempts: 1, cleanupTimeoutMs: 20 },
			),
		).rejects.toThrow("poll timed out");

		expect(closed).toBe(true);
	});

	it("closes a surface reported after launch cancellation wins the race", async () => {
		const closed: string[] = [];
		await expect(
			runnerTesting.runSubagentWithBackend(
				{ name: "Anvil: late surface", task: "inspect", cwd: "/repo", runId: `late-surface-${Date.now()}`, stepId: "late", timeoutMs: 10 },
				{
					isAvailable: () => true,
					unavailableMessage: () => "unavailable",
					createSurface: async (_name, _signal, onCreated) => {
						await delay(20);
						onCreated?.("surface:late");
						return "surface:late";
					},
					sendLongCommand: async () => {},
					pollForExit: async () => ({ reason: "done", exitCode: 0 }),
					closeSurface: async (surface) => {
						closed.push(surface);
					},
				},
				undefined,
				{ attempts: 1, cleanupTimeoutMs: 20 },
			),
		).rejects.toThrow(/timed out after 10ms/i);
		await delay(25);

		expect(closed).toEqual(["surface:late"]);
	});

	it("cleans every surface reported by a fallback creation path", async () => {
		const closed: string[] = [];
		await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: fallback surfaces", task: "inspect", cwd: "/repo", runId: `fallback-surfaces-${Date.now()}`, stepId: "fallback", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async (_name, _signal, onCreated) => {
					onCreated?.("surface:orphaned-fallback");
					onCreated?.("surface:active");
					return "surface:active";
				},
				sendLongCommand: async (_surface, command) => {
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async (surface) => {
					closed.push(surface);
				},
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1, cleanupTimeoutMs: 20 },
		);

		expect(closed.sort()).toEqual(["surface:active", "surface:orphaned-fallback"]);
	});

	it("retries a bootstrap failure before dispatching work", async () => {
		const calls: string[] = [];
		let bootstraps = 0;
		await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: retry", task: "inspect", cwd: "/repo", runId: `retry-${Date.now()}`, stepId: "retry", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => `surface:${bootstraps + 1}`,
				sendLongCommand: async (_surface, command) => {
					bootstraps += 1;
					calls.push(`bootstrap:${bootstraps}`);
					if (bootstraps === 2) {
						const sessionFile = command.match(/--session '([^']+)'/)?.[1];
						if (!sessionFile) throw new Error("missing session file");
						writeSubagentReadySidecar(sessionFile);
					}
				},
				pollForExit: async () => ({ reason: "done", exitCode: 0 }),
				closeSurface: async () => calls.push("close"),
			},
			undefined,
			{ readyTimeoutMs: 1, attempts: 2, retryDelayMs: 0 },
		);

		expect(calls).toEqual(["bootstrap:1", "close", "bootstrap:2", "close"]);
	});

	it("retries provider transport failures before accepting a successful subagent run", async () => {
		let polls = 0;
		const result = await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: transport retry", task: "inspect", cwd: "/repo", runId: `transport-retry-${Date.now()}`, stepId: "retry", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:1",
				sendLongCommand: async (_surface, command) => {
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async (_surface, sessionFile) => {
					polls += 1;
					if (polls < 3) {
						writeFileSync(
							sessionFile,
							JSON.stringify({
								type: "message",
								message: { role: "assistant" },
								diagnostics: [{ type: "provider_transport_failure" }],
							}),
							"utf8",
						);
						return { reason: "sentinel" as const, exitCode: 1, errorMessage: "Subagent exited with code 1; terminal output omitted." };
					}
					return { reason: "done" as const, exitCode: 0 };
				},
				closeSurface: async () => {},
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1, transportRetryDelayMs: 0 },
		);

		expect(polls).toBe(3);
		expect(result.exitCode).toBe(0);
	});

	it("does not retry ordinary exit-code-1 task failures", async () => {
		let polls = 0;
		const result = await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: task failure", task: "inspect", cwd: "/repo", runId: `task-failure-${Date.now()}`, stepId: "failure", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:1",
				sendLongCommand: async (_surface, command) => {
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					polls += 1;
					return { reason: "sentinel" as const, exitCode: 1, errorMessage: "Subagent exited with code 1; terminal output omitted." };
				},
				closeSurface: async () => {},
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1, transportRetryDelayMs: 0 },
		);

		expect(polls).toBe(1);
		expect(result.errorMessage).toBe("Subagent exited with code 1; failure details omitted.");
	});

	it("fails after three provider transport failures in five minutes", async () => {
		let polls = 0;
		const result = await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: exhausted transport", task: "inspect", cwd: "/repo", runId: `transport-exhausted-${Date.now()}`, stepId: "retry", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:1",
				sendLongCommand: async (_surface, command) => {
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					polls += 1;
					return { reason: "error" as const, exitCode: 1, errorMessage: "Subagent exited with stopReason=error; provider details omitted." };
				},
				closeSurface: async () => {},
			},
			undefined,
			{ readyTimeoutMs: 10, attempts: 1, transportRetryDelayMs: 0 },
		);

		expect(polls).toBe(3);
		expect(result.errorMessage).toBe("Subagent encountered 3 provider transport failures within 5 minutes.");
	});

	it("resets the transport-failure budget after the five-minute window", async () => {
		let polls = 0;
		const timestamps = [0, 5 * 60 * 1000 + 1];
		const result = await runnerTesting.runSubagentWithBackend(
			{ name: "Anvil: reset transport", task: "inspect", cwd: "/repo", runId: `transport-reset-${Date.now()}`, stepId: "retry", timeoutMs: 100 },
			{
				isAvailable: () => true,
				unavailableMessage: () => "unavailable",
				createSurface: async () => "surface:1",
				sendLongCommand: async (_surface, command) => {
					const sessionFile = command.match(/--session '([^']+)'/)?.[1];
					if (!sessionFile) throw new Error("missing session file");
					writeSubagentReadySidecar(sessionFile);
				},
				pollForExit: async () => {
					polls += 1;
					return polls < 3
						? { reason: "error" as const, exitCode: 1, errorMessage: "Subagent exited with stopReason=error; provider details omitted." }
						: { reason: "done" as const, exitCode: 0 };
				},
				closeSurface: async () => {},
			},
			undefined,
			{
				readyTimeoutMs: 10,
				attempts: 1,
				transportFailureLimit: 2,
				transportRetryDelayMs: 0,
				now: () => timestamps[Math.min(polls - 1, timestamps.length - 1)]!,
			},
		);

		expect(polls).toBe(3);
		expect(result.exitCode).toBe(0);
	});
});

describe("extractLastAssistantText", () => {
	it("returns the last non-empty assistant text", async () => {
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

		await expect(extractLastAssistantText(sessionFile)).resolves.toBe("All done.");
		await expect(summarizeSubagentExit(sessionFile, { reason: "done", exitCode: 0 })).resolves.toEqual({ summary: "All done." });
	});

	it("returns undefined for missing files or sessions without assistant text", async () => {
		await expect(extractLastAssistantText(join(tempDir(), "missing.jsonl"))).resolves.toBeUndefined();

		const sessionFile = join(tempDir(), "empty.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "session" }) + "\n", "utf8");
		await expect(extractLastAssistantText(sessionFile)).resolves.toBeUndefined();
		await expect(summarizeSubagentExit(sessionFile, { reason: "done", exitCode: 0 })).resolves.toEqual({
			summary: "Subagent exited without output.",
		});
	});

	it("scans only a bounded session tail", async () => {
		const sessionFile = join(tempDir(), "large-session.jsonl");
		const oldAssistant = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "obsolete output" }] },
		});
		writeFileSync(sessionFile, `${oldAssistant}\n${"x".repeat(MAX_SUBAGENT_SESSION_SCAN_BYTES + 1)}`, "utf8");

		await expect(extractLastAssistantText(sessionFile)).resolves.toBeUndefined();
	});

	it("rejects session-file symlinks", async () => {
		const dir = tempDir();
		const target = join(dir, "target.jsonl");
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(target, JSON.stringify({ type: "session" }), "utf8");
		symlinkSync(target, sessionFile);

		await expect(extractLastAssistantText(sessionFile)).rejects.toThrow(/symbolic links are not allowed/i);
	});

	it("does not persist failed child output or diagnostics as the summary", async () => {
		const sessionFile = join(tempDir(), "failed.jsonl");
		const secret = "API_TOKEN=do-not-persist";
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: secret }] } }),
			"utf8",
		);

		const result = await summarizeSubagentExit(sessionFile, {
			reason: "error",
			exitCode: 1,
			errorMessage: `Provider failed: ${secret}`,
		});

		expect(result).toEqual({
			summary: "Subagent exited with code 1; failure details omitted.",
			errorMessage: "Subagent exited with code 1; failure details omitted.",
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});
});

const expectedReviewCheckId = "review-check-1";

function readReviewVerdict(sessionFile: string) {
	return readIndependentReviewVerdict(sessionFile, expectedReviewCheckId);
}

describe("independent review verdict sidecar protocol", () => {
	it("writes and parses a valid structured verdict without persisting reviewer prose", async () => {
		const sessionFile = join(tempDir(), "review.jsonl");
		const secret = "API_TOKEN=must-not-persist";
		const verdict = { checkId: expectedReviewCheckId, pass: true, reason: `Artifacts pass; observed ${secret}` };

		await writeIndependentReviewVerdict(sessionFile, verdict);

		const persisted = readFileSync(`${sessionFile}.verdict.json`, "utf8");
		expect(persisted).not.toContain(secret);
		expect(JSON.parse(persisted)).toEqual({
			check_id: verdict.checkId,
			pass: verdict.pass,
			reason: INDEPENDENT_REVIEW_PASS_REASON,
		});
		await expect(readReviewVerdict(sessionFile)).resolves.toEqual({
			checkId: verdict.checkId,
			pass: verdict.pass,
			reason: INDEPENDENT_REVIEW_PASS_REASON,
		});
	});

	it("preserves a failed verdict while replacing its untrusted reason", async () => {
		const sessionFile = join(tempDir(), "failed-review.jsonl");
		const verdict = { checkId: expectedReviewCheckId, pass: false, reason: "Required artifact is missing." };

		await writeIndependentReviewVerdict(sessionFile, verdict);

		await expect(readReviewVerdict(sessionFile)).resolves.toEqual({
			checkId: verdict.checkId,
			pass: false,
			reason: INDEPENDENT_REVIEW_FAIL_REASON,
		});
	});

	it("reports a missing verdict sidecar as a transport error, not a failed review", async () => {
		await expect(readReviewVerdict(join(tempDir(), "missing.jsonl"))).rejects.toThrow(/missing.*verdict/i);
	});

	it("rejects malformed verdict sidecars clearly", async () => {
		const sessionFile = join(tempDir(), "malformed.jsonl");
		writeFileSync(`${sessionFile}.verdict.json`, "{ not valid json", "utf8");

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/malformed.*verdict/i);
	});

	it("rejects invalid UTF-8 instead of replacing malformed bytes", async () => {
		const sessionFile = join(tempDir(), "invalid-utf8.jsonl");
		writeFileSync(
			`${sessionFile}.verdict.json`,
			Buffer.concat([
				Buffer.from(`{"check_id":"${expectedReviewCheckId}","pass":true,"reason":"`, "utf8"),
				Buffer.from([0xff]),
				Buffer.from('"}', "utf8"),
			]),
		);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/malformed.*invalid utf-8/i);
	});

	it("rejects FIFO sidecars without blocking", async () => {
		const sessionFile = join(tempDir(), "fifo.jsonl");
		execFileSync("mkfifo", [`${sessionFile}.verdict.json`]);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/expected a regular file/i);
	});

	it("does not retain verdict claims after their filesystem sidecar is removed", async () => {
		const sessionFile = join(tempDir(), "released-claim.jsonl");
		await writeIndependentReviewVerdict(sessionFile, {
			checkId: expectedReviewCheckId,
			pass: true,
			reason: "first",
		});
		rmSync(`${sessionFile}.verdict.json`);

		await writeIndependentReviewVerdict(sessionFile, {
			checkId: expectedReviewCheckId,
			pass: false,
			reason: "replacement after cleanup",
		});

		await expect(readReviewVerdict(sessionFile)).resolves.toMatchObject({ pass: false });
	});

	it("records a bounded duplicate marker instead of growing the sidecar", async () => {
		const sessionFile = join(tempDir(), "duplicate.jsonl");
		await writeIndependentReviewVerdict(sessionFile, {
			checkId: expectedReviewCheckId,
			pass: true,
			reason: "first",
		});
		for (let attempt = 0; attempt < 20; attempt++) {
			await writeIndependentReviewVerdict(sessionFile, {
				checkId: expectedReviewCheckId,
				pass: false,
				reason: `duplicate ${attempt}`,
			});
		}

		const sidecar = readFileSync(`${sessionFile}.verdict.json`, "utf8");
		expect(sidecar.length).toBeLessThan(100);
		expect(JSON.parse(sidecar)).toEqual({ transport_error: "duplicate" });
		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/duplicate.*verdict/i);
	});

	it("invalidates an accepted verdict when the second verdict is itself invalid", async () => {
		const sessionFile = join(tempDir(), "invalid-duplicate.jsonl");
		await writeIndependentReviewVerdict(sessionFile, {
			checkId: expectedReviewCheckId,
			pass: true,
			reason: "first",
		});

		await expect(
			writeIndependentReviewVerdict(sessionFile, {
				checkId: expectedReviewCheckId,
				pass: false,
				reason: "x".repeat(MAX_REVIEW_REASON_BYTES + 1),
			}),
		).resolves.toBeUndefined();

		expect(JSON.parse(readFileSync(`${sessionFile}.verdict.json`, "utf8"))).toEqual({ transport_error: "duplicate" });
		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/duplicate.*verdict/i);
	});

	it("rejects multiple externally-written verdict records", async () => {
		const sessionFile = join(tempDir(), "multiple-records.jsonl");
		writeFileSync(
			`${sessionFile}.verdict.json`,
			[
				JSON.stringify({ check_id: expectedReviewCheckId, pass: true, reason: "first" }),
				JSON.stringify({ check_id: expectedReviewCheckId, pass: false, reason: "second" }),
			].join("\n"),
			"utf8",
		);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/duplicate.*verdict/i);
	});

	it("normalizes reviewer prose from externally-written sidecars before returning it", async () => {
		const sessionFile = join(tempDir(), "external-secret.jsonl");
		const secret = "unmarked-workspace-secret-value";
		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: expectedReviewCheckId, pass: false, reason: secret }),
			"utf8",
		);

		const verdict = await readReviewVerdict(sessionFile);
		expect(verdict).toEqual({
			checkId: expectedReviewCheckId,
			pass: false,
			reason: INDEPENDENT_REVIEW_FAIL_REASON,
		});
		expect(JSON.stringify(verdict)).not.toContain(secret);
	});

	it("rejects verdicts for a different runtime check id without echoing reviewer input", async () => {
		const sessionFile = join(tempDir(), "wrong-check.jsonl");
		const untrustedCheckId = "another-check-secret";
		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: untrustedCheckId, pass: true, reason: "looks good" }),
			"utf8",
		);

		const error = await readReviewVerdict(sessionFile).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/check.?id.*expected check.?id/i);
		expect((error as Error).message).not.toContain(untrustedCheckId);
	});

	it("strictly validates every required verdict field", async () => {
		const sessionFile = join(tempDir(), "invalid-fields.jsonl");
		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: expectedReviewCheckId, pass: "true", reason: 42 }),
			"utf8",
		);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/invalid.*verdict/i);
	});

	it("rejects unexpected fields so the transport schema stays exact", async () => {
		const sessionFile = join(tempDir(), "unexpected-field.jsonl");
		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: expectedReviewCheckId, pass: true, reason: "looks good", extra: "not allowed" }),
			"utf8",
		);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/invalid.*verdict/i);
	});

	it("bounds reviewer-controlled reasons on both write and parse", async () => {
		const sessionFile = join(tempDir(), "oversized-reason.jsonl");
		await expect(
			writeIndependentReviewVerdict(sessionFile, {
				checkId: expectedReviewCheckId,
				pass: true,
				reason: "x".repeat(4097),
			}),
		).rejects.toThrow(/reason exceeds 4096 bytes/i);
		expect(existsSync(`${sessionFile}.verdict.json`)).toBe(false);

		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: expectedReviewCheckId, pass: true, reason: "x".repeat(4097) }),
			"utf8",
		);
		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/reason exceeds 4096 bytes/i);
	});

	it("rejects unsafe control characters in reasons on both write and parse", async () => {
		const sessionFile = join(tempDir(), "unsafe-reason.jsonl");
		await expect(
			writeIndependentReviewVerdict(sessionFile, {
				checkId: expectedReviewCheckId,
				pass: true,
				reason: "looks good\u001b[2J",
			}),
		).rejects.toThrow(/unsupported control characters/i);

		writeFileSync(
			`${sessionFile}.verdict.json`,
			JSON.stringify({ check_id: expectedReviewCheckId, pass: true, reason: "looks good\u001b[2J" }),
			"utf8",
		);
		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/unsupported control characters/i);
	});

	it("rejects oversized sidecars without reading them in full", async () => {
		const sessionFile = join(tempDir(), "oversized-sidecar.jsonl");
		writeFileSync(`${sessionFile}.verdict.json`, "x".repeat(20 * 1024), "utf8");
		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/exceeds.*bytes/i);
	});

	it("does not follow a pre-existing verdict sidecar symlink", async () => {
		const dir = tempDir();
		const sessionFile = join(dir, "symlink.jsonl");
		const target = join(dir, "target.txt");
		writeFileSync(target, "must remain unchanged", "utf8");
		symlinkSync(target, `${sessionFile}.verdict.json`);

		await writeIndependentReviewVerdict(sessionFile, {
			checkId: expectedReviewCheckId,
			pass: false,
			reason: "untrusted",
		});

		expect(readFileSync(target, "utf8")).toBe("must remain unchanged");
		expect(lstatSync(`${sessionFile}.verdict.json`).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(`${sessionFile}.verdict.json`, "utf8"))).toEqual({ transport_error: "duplicate" });
	});

	it("refuses to read a verdict through a symbolic link", async () => {
		const dir = tempDir();
		const sessionFile = join(dir, "read-symlink.jsonl");
		const target = join(dir, "target.json");
		writeFileSync(target, JSON.stringify({ check_id: expectedReviewCheckId, pass: true, reason: "secret" }), "utf8");
		symlinkSync(target, `${sessionFile}.verdict.json`);

		await expect(readReviewVerdict(sessionFile)).rejects.toThrow(/symbolic links are not allowed/i);
	});

	it("does not expose the reviewer reason in the tool receipt", () => {
		const secret = "reviewer-controlled-secret";
		expect(JSON.stringify(independentReviewVerdictReceipt())).not.toContain(secret);
		expect(independentReviewVerdictReceipt()).toEqual({
			content: [{ type: "text", text: "Anvil verdict recorded." }],
			details: { recorded: true },
		});
	});
});

describe("child auto-exit helpers", () => {
	it("replaces an exit-sidecar symlink without writing through it", () => {
		const dir = tempDir();
		const sessionFile = join(dir, "exit-symlink.jsonl");
		const target = join(dir, "target.txt");
		writeFileSync(target, "must remain unchanged", "utf8");
		symlinkSync(target, `${sessionFile}.exit`);

		writeSubagentExitSidecar(sessionFile);

		expect(readFileSync(target, "utf8")).toBe("must remain unchanged");
		expect(lstatSync(`${sessionFile}.exit`).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"))).toEqual({ type: "done" });
	});

	it("exits after a normally completed turn", () => {
		expect(shouldAutoExitOnAgentEnd([{ role: "assistant", stopReason: "end" }])).toBe(true);
		expect(shouldAutoExitOnAgentEnd(undefined)).toBe(true);
	});

	it("stays open when the turn was aborted", () => {
		expect(shouldAutoExitOnAgentEnd([{ role: "assistant", stopReason: "aborted" }])).toBe(false);
	});

	it("reports provider errors without copying potentially secret diagnostics", () => {
		const secret = "API_TOKEN=do-not-persist";
		const error = findLatestAssistantError([{ role: "assistant", stopReason: "error", errorMessage: secret }]);

		expect(error).toBe("Subagent agent loop ended with stopReason=error; provider details omitted.");
		expect(error).not.toContain(secret);
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

	it("ignores a FIFO exit sidecar instead of blocking the parent", async () => {
		const sessionFile = join(tempDir(), "fifo-exit.jsonl");
		execFileSync("mkfifo", [`${sessionFile}.exit`]);

		await expect(
			pollForExitWithReadScreen(
				async () => "__ANVIL_SUBAGENT_DONE_fifo-nonce_0__",
				"surface:1",
				sessionFile,
				undefined,
				1,
				20,
				"fifo-nonce",
			),
		).resolves.toEqual({ reason: "sentinel", exitCode: 0 });
	});

	it("omits potentially secret diagnostics from error sidecars", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		const secret = "API_TOKEN=do-not-persist";
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: secret }), "utf8");

		const exit = await pollForExit("surface:1", sessionFile);

		expect(exit).toEqual({
			reason: "error",
			exitCode: 1,
			errorMessage: "Subagent exited with stopReason=error; provider details omitted.",
		});
		expect(JSON.stringify(exit)).not.toContain(secret);
	});

	it("omits terminal output when a child exits nonzero without an exit sidecar", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		const nonce = "failure-nonce";
		const secret = "API_TOKEN=do-not-persist";
		const readFailedChild = async () => [`Error: extension failed to load (${secret})`, `__ANVIL_SUBAGENT_DONE_${nonce}_1__`].join("\n");

		const exit = await pollForExitWithReadScreen(readFailedChild, "surface:1", sessionFile, undefined, 1, 20, nonce);

		expect(exit).toEqual({
			reason: "sentinel",
			exitCode: 1,
			errorMessage: "Subagent exited with code 1; terminal output omitted.",
		});
		expect(JSON.stringify(exit)).not.toContain(secret);
	});

	it("rejects when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(pollForExit("surface:1", join(tempDir(), "s.jsonl"), controller.signal)).rejects.toThrow("aborted");
	});

	it("times out when a subagent never writes an exit sidecar or sentinel", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		let attempts = 0;
		const readRunningSurface = async () => {
			attempts += 1;
			return "still working";
		};

		await expect(pollForExitWithReadScreen(readRunningSurface, "surface:1", sessionFile, undefined, 1, 5)).rejects.toThrow(/timed out/i);
		expect(attempts).toBeGreaterThan(0);
	});

	it("bails out when the cmux surface closes before an exit sidecar is written", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		const timeoutMs = 100;
		const startedAt = Date.now();
		const readClosedSurface = async () => {
			throw new Error("surface closed");
		};

		await expect(
			pollForExitWithReadScreen(readClosedSurface, "surface:missing", sessionFile, undefined, 1, timeoutMs),
		).rejects.toThrow(/surface closed before completion/i);
		expect(Date.now() - startedAt).toBeLessThan(timeoutMs);
	});

	it("enforces the timeout when a failed screen read crosses the deadline", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		let attempts = 0;
		const readClosedSurfaceSlowly = async () => {
			attempts += 1;
			if (attempts > 1) await delay(60);
			throw new Error("surface closed");
		};

		await expect(
			pollForExitWithReadScreen(readClosedSurfaceSlowly, "surface:missing", sessionFile, undefined, 1, 50),
		).rejects.toThrow(/timed out/i);
		expect(attempts).toBe(2);
	});

	it("enforces the timeout and cancels a screen read that never settles", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		let readSignal: AbortSignal | undefined;
		let readAborted = false;
		const readHungSurface = (_surface: string, _lines?: number, signal?: AbortSignal) => {
			readSignal = signal;
			signal?.addEventListener("abort", () => {
				readAborted = true;
			});
			return new Promise<string>(() => undefined);
		};
		const startedAt = Date.now();

		await expect(
			pollForExitWithReadScreen(readHungSurface, "surface:hung", sessionFile, undefined, 1, 25),
		).rejects.toThrow(/timed out/i);
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(readSignal).toBeInstanceOf(AbortSignal);
		expect(readSignal?.aborted).toBe(true);
		expect(readAborted).toBe(true);
	});

	it("keeps timing out when a single slow read failure crosses the deadline without a closed-surface streak", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		let attempts = 0;
		const readScreen = async () => {
			attempts += 1;
			await delay(30);
			throw new Error("transient read failure");
		};

		await expect(pollForExitWithReadScreen(readScreen, "surface:flaky", sessionFile, undefined, 1, 20)).rejects.toThrow(/timed out/i);
		expect(attempts).toBe(1);
	});

	it("ignores sentinel-like text that was printed by the subagent", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		const readQuotedSentinel = async () => "reviewing docs: __ANVIL_SUBAGENT_DONE_0__ should not terminate this run";

		await expect(
			pollForExitWithReadScreen(readQuotedSentinel, "surface:1", sessionFile, undefined, 1, 5),
		).rejects.toThrow(/timed out/i);
	});

	it("does not treat quoted Pi startup prompts as blocked subagent startup", async () => {
		const sessionFile = join(tempDir(), "session.jsonl");
		const quotedPrompt = [
			"The agent is reviewing this known Pi prompt text:",
			"cwd from session file does not exist",
			"/missing/repo",
			"",
			"continue in current cwd",
			"/fallback/repo",
			"",
			"→ Continue",
			"  Cancel",
		].join("\n");
		const readQuotedPrompt = async () => quotedPrompt;

		await expect(
			pollForExitWithReadScreen(readQuotedPrompt, "surface:1", sessionFile, undefined, 1, 5),
		).rejects.toThrow(/timed out/i);
	});
});

// Static contract tests for the cmux launch hardening issues are intentionally
// source-level until the launch path is dependency-injected enough for isolated
// process-spawn tests.
describe("cmux launch hardening contracts", () => {
	it("does not use synchronous process calls or blocking sleeps on the launch path", () => {
		const source = readFileSync(new URL("../src/subagent/cmux.ts", import.meta.url), "utf8");

		expect(source).not.toMatch(/\bexec(?:File)?Sync\b/);
		expect(source).not.toContain("Atomics.wait");
	});

	it("sends subagent launch commands directly without wrapper scripts", async () => {
		const dir = tempDir();
		const scriptPath = join(dir, "launch.sh");
		const logFile = join(dir, "cmux.log");
		const fakeCmux = join(dir, "cmux");
		writeFileSync(fakeCmux, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(logFile)}\n`, { mode: 0o755 });
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath ?? ""}`;
		try {
			await sendLongCommand("surface:1", "echo hello", scriptPath);
			await sendInput("surface:1", "@/tmp/task.md");
		} finally {
			process.env.PATH = previousPath;
		}

		expect(existsSync(scriptPath)).toBe(false);
		expect(readFileSync(logFile, "utf8")).toContain("echo hello");
		const log = readFileSync(logFile, "utf8");
		expect(log).toContain("@/tmp/task.md");
		expect(log).toContain("@/tmp/task.md\n");
		expect((log.match(/send\n--surface\nsurface:1\n\n/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});

	it("creates per-run temporary workspaces with owner-only permissions", () => {
		const source = readFileSync(new URL("../src/subagent/runner.ts", import.meta.url), "utf8");

		expect(source).toContain("mkdirSync(workDir, { recursive: true, mode: 0o700 })");
	});
});

describe("interpretExitSidecar", () => {
	it("treats unknown payloads as done", () => {
		expect(__testing__.interpretExitSidecar({})).toEqual({ reason: "done", exitCode: 0 });
		expect(__testing__.interpretExitSidecar({ type: "error" })).toEqual({
			reason: "error",
			exitCode: 1,
			errorMessage: "Subagent exited with stopReason=error; provider details omitted.",
		});
	});
});
