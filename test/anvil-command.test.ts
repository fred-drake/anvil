import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAnvil, { __testing__ } from "../src/index.ts";
import { INDEPENDENT_REVIEW_MODE, INDEPENDENT_REVIEW_PASS_REASON, INDEPENDENT_REVIEW_TOOL_NAMES } from "../src/subagent/child.ts";
import { readIndependentReviewVerdict } from "../src/subagent/runner.ts";

const ORIGINAL_HERDR_ENV = process.env.HERDR_ENV;
const ORIGINAL_CMUX_SHELL_INTEGRATION = process.env.CMUX_SHELL_INTEGRATION;
const ORIGINAL_CMUX_SOCKET_PATH = process.env.CMUX_SOCKET_PATH;
const ORIGINAL_SUBAGENT_SESSION = process.env.PI_ANVIL_SUBAGENT_SESSION;
const ORIGINAL_SUBAGENT_MODE = process.env.PI_ANVIL_SUBAGENT_MODE;
const ORIGINAL_REVIEW_ROOT = process.env.PI_ANVIL_REVIEW_ROOT;
const CHILD_REGISTRATION_KEY = Symbol.for("@fred-drake/anvil/subagent-child-registered");

let root: string | undefined;

beforeEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.CMUX_SHELL_INTEGRATION;
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.PI_ANVIL_SUBAGENT_SESSION;
	delete process.env.PI_ANVIL_SUBAGENT_MODE;
	delete process.env.PI_ANVIL_REVIEW_ROOT;
	delete (globalThis as Record<symbol, unknown>)[CHILD_REGISTRATION_KEY];
});

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
	restoreEnv("HERDR_ENV", ORIGINAL_HERDR_ENV);
	restoreEnv("CMUX_SHELL_INTEGRATION", ORIGINAL_CMUX_SHELL_INTEGRATION);
	restoreEnv("CMUX_SOCKET_PATH", ORIGINAL_CMUX_SOCKET_PATH);
	restoreEnv("PI_ANVIL_SUBAGENT_SESSION", ORIGINAL_SUBAGENT_SESSION);
	restoreEnv("PI_ANVIL_SUBAGENT_MODE", ORIGINAL_SUBAGENT_MODE);
	restoreEnv("PI_ANVIL_REVIEW_ROOT", ORIGINAL_REVIEW_ROOT);
	delete (globalThis as Record<symbol, unknown>)[CHILD_REGISTRATION_KEY];
});

describe("Anvil subagent mode", () => {
	it("does not replace normal delegated-child workspace tools with review tools", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-step-child-"));
		process.env.PI_ANVIL_SUBAGENT_SESSION = join(root, "session.jsonl");
		const pi = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn(),
		} as any;

		piAnvil(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		expect(pi.on).toHaveBeenCalledOnce();
		expect(pi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
	});

	it("registers review child behavior once and wires its verdict tool to the sidecar writer", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-child-"));
		const sessionFile = join(root, "session.jsonl");
		process.env.PI_ANVIL_SUBAGENT_SESSION = sessionFile;
		process.env.PI_ANVIL_SUBAGENT_MODE = INDEPENDENT_REVIEW_MODE;
		process.env.PI_ANVIL_REVIEW_ROOT = root;
		type RegisteredTool = { name: string; execute: (toolCallId: string, params: any) => Promise<unknown> };
		const registeredTools: RegisteredTool[] = [];
		let verdictTool: RegisteredTool | undefined;
		const pi = {
			registerTool: vi.fn((tool: RegisteredTool) => {
				registeredTools.push(tool);
				if (tool.name === "anvil_verdict") verdictTool = tool;
			}),
			registerMessageRenderer: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn(),
		} as any;

		// Pi may discover the package extension in addition to the launcher's
		// explicit `-e index.ts`; together they must still register only once.
		piAnvil(pi);
		piAnvil(pi);

		expect(pi.registerTool).toHaveBeenCalledTimes(INDEPENDENT_REVIEW_TOOL_NAMES.length);
		expect(registeredTools.map((tool) => tool.name).sort()).toEqual([...INDEPENDENT_REVIEW_TOOL_NAMES].sort());
		expect(verdictTool).toEqual(expect.objectContaining({ name: "anvil_verdict" }));
		await verdictTool!.execute("tool-call", {
			check_id: "workflow:step:quality",
			pass: true,
			reason: "Artifacts satisfy the criteria.",
		});
		await expect(readIndependentReviewVerdict(sessionFile, "workflow:step:quality")).resolves.toEqual({
			checkId: "workflow:step:quality",
			pass: true,
			reason: INDEPENDENT_REVIEW_PASS_REASON,
		});
		expect(pi.on).toHaveBeenCalledOnce();
		expect(pi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
		expect(pi.registerMessageRenderer).not.toHaveBeenCalled();
		expect(pi.registerCommand).not.toHaveBeenCalled();
	});
});

describe("/anvil validate command", () => {
	it("reloads workflows instead of using stale autocomplete discovery cache", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		const workflowsDir = join(project, ".pi", "anvil", "workflows");
		const workflowFile = join(workflowsDir, "demo.ts");
		await mkdir(workflowsDir, { recursive: true });

		const validWorkflow = `export default { name: "demo", steps: [{ id: "one", prompt: "ok" }] };`;
		await writeFile(workflowFile, validWorkflow, "utf8");

		let command: { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => Promise<any> } | undefined;
		const pi = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn((_name: string, registered: typeof command) => {
				command = registered;
			}),
			sendMessage: vi.fn(),
		} as any;
		piAnvil(pi);

		await command!.getArgumentCompletions("validate d");
		const before = await stat(workflowFile);
		const invalidWorkflow = padToLength(`throw new Error("boom");`, validWorkflow.length);
		await writeFile(workflowFile, invalidWorkflow, "utf8");
		await utimes(workflowFile, before.atime, before.mtime);

		const ctx = {
			cwd: project,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
		};
		await command!.handler("validate demo", ctx);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "anvil-validate", content: expect.stringContaining("boom") }),
			expect.objectContaining({ triggerTurn: false }),
		);
	});
});

describe("/anvil command completions", () => {
	it("does not discover workflows from process.cwd for legacy argument completions", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const processProject = join(root, "process-project");
		await mkdir(join(processProject, ".pi", "anvil", "workflows"), { recursive: true });
		await writeFile(
			join(processProject, ".pi", "anvil", "workflows", "process-only.ts"),
			`export default { name: "process-only", steps: [{ id: "one", prompt: "wrong cwd" }] };`,
			"utf8",
		);
		const previousCwd = process.cwd();
		let command: { getArgumentCompletions: (prefix: string) => Promise<any> } | undefined;
		const pi = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn((_name: string, registered: typeof command) => {
				command = registered;
			}),
			sendMessage: vi.fn(),
		} as any;

		try {
			process.chdir(processProject);
			piAnvil(pi);
			const completions = await command!.getArgumentCompletions("run ");

			expect(completions).not.toContainEqual(expect.objectContaining({ label: "process-only" }));
		} finally {
			process.chdir(previousCwd);
		}
	});
});

describe("/anvil run command", () => {
	it("reserves the active run slot before async discovery and idle waits", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
		await writeFile(
			join(project, ".pi", "anvil", "workflows", "demo.ts"),
			`export default { name: "demo", steps: [{ id: "one", prompt: "Do {input}" }] };`,
			"utf8",
		);

		const events = new Map<string, Array<(...args: any[]) => void>>();
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const notifications: Array<{ message: string; type?: string }> = [];
		const idleGate = deferred<void>();
		let idle = false;

		const pi = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			on: vi.fn((event: string, callback: (...args: any[]) => void) => {
				events.set(event, [...(events.get(event) ?? []), callback]);
			}),
			registerCommand: vi.fn((_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
				commandHandler = command.handler;
			}),
			sendUserMessage: vi.fn(() => {
				for (const callback of events.get("agent_start") ?? []) callback();
				for (const callback of events.get("agent_end") ?? []) callback();
			}),
			sendMessage: vi.fn(),
			exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
			appendEntry: vi.fn(),
			getThinkingLevel: vi.fn(() => "medium"),
			setThinkingLevel: vi.fn(),
			setModel: vi.fn(async () => true),
		} as any;
		piAnvil(pi);
		expect(commandHandler).toBeDefined();

		const ctx = {
			cwd: project,
			model: { provider: "openai", id: "default" },
			modelRegistry: { getAll: () => [{ provider: "openai", id: "default" }] },
			ui: {
				notify: vi.fn((message: string, type?: string) => notifications.push({ message, type })),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
			},
			isIdle: vi.fn(() => idle),
			waitForIdle: vi.fn(async () => {
				await idleGate.promise;
				idle = true;
			}),
			hasPendingMessages: vi.fn(() => false),
			abort: vi.fn(),
		};

		const first = commandHandler!("run demo first", ctx);
		const second = commandHandler!("run demo second", ctx);
		await waitUntil(() => ctx.waitForIdle.mock.calls.length === 1);
		idleGate.resolve();
		await Promise.all([first, second]);

		expect(notifications.filter((entry) => entry.message.startsWith("Started Anvil workflow"))).toHaveLength(1);
		expect(notifications).toContainEqual({ message: "An Anvil workflow is already running in this session.", type: "error" });
	});
});

describe("/anvil status command", () => {
	it("notifies exactly when no active run exists and has no execution or mutation side effects", async () => {
		const entries: Array<Record<string, unknown>> = [];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("status", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No Anvil workflow is running.", "info");
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.abort).not.toHaveBeenCalled();
	});

	it("reports only the safe loading identity while a run reservation is resolving", async () => {
		const entries: Array<Record<string, unknown>> = [{
			type: "custom",
			customType: "anvil-run",
			data: {
				runId: "foreign-run",
				workflowName: "TOKEN=checkpoint-secret `| <script>",
				input: "/home/me/.ssh/id_rsa",
				phase: "step_start",
				stepId: "outside-step",
				stepIndex: 999_999,
				loopCounts: { "outside-step": 999_999_999 },
				reason: "provider child diagnostic TOKEN=reason-secret",
			},
		}];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project-that-does-not-exist", entries);

		const starting = command!.handler("run user-controlled-name task", ctx);
		await command!.handler("status", ctx);
		await starting;

		const status = pi.sendMessage.mock.calls.find(([message]) => message.customType === "anvil-status")?.[0];
		expect(status?.content).toMatch(/loading|starting/i);
		expect(status?.content).not.toMatch(/user-controlled-name|checkpoint-secret|reason-secret|id_rsa|<script>|`\|/);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("posts engine-authoritative active progress without consulting stale session checkpoints", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-status-"));
		const project = join(root, "project");
		await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
		await writeFile(join(project, ".pi", "anvil", "workflows", "forge.ts"), `export default { name: "forge", steps: [{ id: "plan", title: "Plan", prompt: "plan" }, { id: "implement", title: "Implement", prompt: "implement" }] };`, "utf8");
		const entries: Array<Record<string, unknown>> = [];
		const { command, pi, events } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		// Keep the first engine turn blocked so status observes live progress.
		pi.sendUserMessage.mockImplementation(() => {
			for (const callback of events.get("agent_start") ?? []) callback();
		});

		await command!.handler("run forge task", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length === 1);
		entries.push(
			{ customType: "anvil-run", data: { runId: "foreign", workflowName: "forge", input: "task", phase: "step_start", stepId: "implement", stepIndex: 1, loopCounts: { "tests->implement": 99 } } },
			{ customType: "anvil-run", data: { runId: "stale", workflowName: "forge", input: "task", phase: "step_start", stepId: "implement", stepIndex: 1, loopCounts: { "tests->implement": 2 } } },
		);
		now.mockReturnValue(3_500);
		const execCallsBeforeStatus = pi.exec.mock.calls.length;
		const entryAppendsBeforeStatus = pi.appendEntry.mock.calls.length;
		await command!.handler("status", ctx);

		const statuses = pi.sendMessage.mock.calls.filter(([message]) => message.customType === "anvil-status");
		const content = statuses.at(-1)?.[0].content as string;
		expect(content).toContain("forge");
		expect(content).toMatch(/1\/2.*Plan/s);
		expect(content).toMatch(/Retry count: 0/);
		expect(content).toContain("2.5s");
		expect(pi.exec).toHaveBeenCalledTimes(execCallsBeforeStatus);
		expect(pi.appendEntry).toHaveBeenCalledTimes(entryAppendsBeforeStatus);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();

		await command!.handler("abort", ctx);
		for (const callback of events.get("agent_end") ?? []) callback();
		now.mockRestore();
	});

	it("ignores foreign, malformed, out-of-range, mismatched, and huge loop-count checkpoints", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-status-"));
		const project = join(root, "project");
		await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
		await writeFile(join(project, ".pi", "anvil", "workflows", "safe.ts"), `export default { name: "safe", steps: [{ id: "plan", title: "Plan", prompt: "plan" }, { id: "verify", title: "Verify", prompt: "verify" }] };`, "utf8");
		const entries: Array<Record<string, unknown>> = [];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);
		const idleGate = deferred<void>();
		ctx.isIdle.mockReturnValue(false);
		ctx.waitForIdle.mockImplementation(() => idleGate.promise);
		const starting = command!.handler("run safe task", ctx);
		await waitUntil(() => ctx.waitForIdle.mock.calls.length === 1);
		await command!.handler("status", ctx);
		const initial = pi.sendMessage.mock.calls.find(([message]) => message.customType === "anvil-status")?.[0].content as string;
		const runId = /Run ID: `([^`]+)`/.exec(initial)?.[1];
		const base = { runId, workflowName: "safe", input: "task", timestamp: "2026-07-12T00:00:00.000Z", phase: "step_start" };
		entries.push(
			{ customType: "anvil-run", data: { ...base, stepId: "plan", stepIndex: 0 } },
			{ customType: "anvil-run", data: { ...base, runId: "foreign", stepId: "verify", stepIndex: 1, reason: "provider diagnostic TOKEN=reason-secret" } },
			{ customType: "anvil-run", data: { ...base, stepId: "plan", stepIndex: 1, input: "/home/me/.ssh/id_rsa" } },
			{ customType: "anvil-run", data: { ...base, stepId: "outside", stepIndex: 999_999, loopCounts: { "TOKEN=checkpoint-secret->outside": 1 } } },
			{ customType: "anvil-run", data: { ...base, stepId: "plan", stepIndex: 0, loopCounts: { arbitrary: 10, "tests->verify": 3, "tests->plan": Number.MAX_SAFE_INTEGER }, command: "<script>bad</script>" } },
			{ customType: "anvil-run", data: { runId } },
		);
		await command!.handler("status", ctx);

		const statuses = pi.sendMessage.mock.calls.filter(([message]) => message.customType === "anvil-status");
		const content = statuses.at(-1)?.[0].content as string;
		expect(content).toContain("Current step: waiting to start");
		expect(content).toContain("Retry count: 0");
		expect(content).not.toMatch(/reason-secret|checkpoint-secret|id_rsa|<script>|999999/);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		await command!.handler("abort", ctx);
		idleGate.resolve();
		await starting;
	});

	it("shows only accepted reloaded workflow metadata during the next blocked watch step", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-status-watch-"));
		const project = join(root, "project");
		const workflowFile = join(project, ".pi", "anvil", "workflows", "watched.ts");
		await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
		await writeFile(workflowFile, `export default { name: "before", steps: [{ id: "one", title: "Old One", prompt: "one" }, { id: "old-two", title: "Old Two", prompt: "two" }] };`);
		const entries: Array<Record<string, unknown>> = [];
		const { command, pi, events } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);
		pi.sendUserMessage.mockImplementation(() => {
			for (const callback of events.get("agent_start") ?? []) callback();
		});

		await command!.handler("run --watch before task", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length === 1);
		await writeFile(workflowFile, `export default { name: "after", steps: [{ id: "inserted", title: "Inserted New", prompt: "new" }, { id: "one", title: "Renamed One", prompt: "one" }, { id: "two-new", title: "Changed Two", prompt: "two" }] };`);
		const future = new Date(Date.now() + 2_000);
		await utimes(workflowFile, future, future);
		for (const callback of events.get("agent_end") ?? []) callback();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect({ sends: pi.sendUserMessage.mock.calls.length, notifications: ctx.ui.notify.mock.calls, entries }).toMatchObject({ sends: 2 });
		expect(ctx.ui.notify.mock.calls).not.toEqual(expect.arrayContaining([[expect.stringMatching(/failed|reload skipped/i), expect.anything()]]));

		await command!.handler("status", ctx);
		const statuses = pi.sendMessage.mock.calls.filter(([message]) => message.customType === "anvil-status");
		const content = statuses.at(-1)?.[0].content as string;
		expect(content).toContain("Workflow: `after`");
		expect(content).toMatch(/1\/3.*Inserted New/s);
		expect(content).not.toMatch(/before|Old One|old-two|Old Two/);

		await command!.handler("abort", ctx);
		for (const callback of events.get("agent_end") ?? []) callback();
	});
});

describe("/anvil independent-review preflight", () => {
	it("ignores an unavailable backend for a check with main fallback when another review is required", () => {
		process.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
		const notify = vi.fn();
		const workflow = {
			name: "mixed-review",
			steps: [{
				id: "implement",
				prompt: "Implement",
				checks: [
					{ type: "agent", prompt: "Required", review: { subagent: "cmux" } },
					{ type: "agent", prompt: "Optional", review: { subagent: "herdr" }, reviewFallback: "main" },
				],
			}],
		} as any;

		expect(__testing__.preflightSubagentBackends(workflow, { ui: { notify } } as any)).toBe(true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("defers unavailable required reviews to gate handling", () => {
		const notify = vi.fn();
		const workflow = {
			name: "required-review",
			steps: [{
				id: "implement",
				prompt: "Implement",
				checks: [{ type: "agent", prompt: "Review", review: { subagent: "cmux" } }],
			}],
		} as any;

		expect(__testing__.preflightSubagentBackends(workflow, { ui: { notify } } as any)).toBe(true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("allows an unavailable review backend only with explicit main fallback", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-review-fallback-"));
		const project = join(root, "project");
		const workflowsDir = join(project, ".pi", "anvil", "workflows");
		await mkdir(workflowsDir, { recursive: true });
		await writeFile(
			join(workflowsDir, "review-fallback.ts"),
			`export default {
				name: "review-fallback",
				steps: [{
					id: "implement",
					prompt: "Implement",
					runInMain: true,
					checks: [{
						type: "agent",
						prompt: "Review",
						review: { subagent: "herdr" },
						reviewFallback: "main",
					}],
				}],
			};`,
			"utf8",
		);

		const events = new Map<string, Array<(...args: any[]) => void>>();
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const notify = vi.fn();
		const pi = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			on: vi.fn((event: string, callback: (...args: any[]) => void) => {
				events.set(event, [...(events.get(event) ?? []), callback]);
			}),
			registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => {
				commandHandler = command.handler;
			}),
			sendUserMessage: vi.fn(() => {
				for (const callback of events.get("agent_start") ?? []) callback();
				for (const callback of events.get("agent_end") ?? []) callback();
			}),
			sendMessage: vi.fn(),
			exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
			appendEntry: vi.fn(),
			getThinkingLevel: vi.fn(() => "medium"),
			setThinkingLevel: vi.fn(),
			setModel: vi.fn(async () => true),
		} as any;
		piAnvil(pi);

		await commandHandler!("run review-fallback task", {
			cwd: project,
			model: { provider: "openai", id: "default" },
			modelRegistry: { getAll: () => [{ provider: "openai", id: "default" }] },
			ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
			isIdle: vi.fn(() => true),
			hasPendingMessages: vi.fn(() => false),
		});
		await waitUntil(() => pi.sendMessage.mock.calls.some(([message]) => message.customType === "anvil-summary"));

		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Started Anvil workflow/), "info");
		expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/herdr independent review backend/i), "error");
		expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Implement"));
	});
});

describe("/anvil history and report commands", () => {
	it("renders session-scoped history and a detailed run report", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("history demo", ctx);
		await command!.handler("report run-prev", ctx);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "anvil-history", content: expect.stringContaining("`run-prev`") }),
			expect.objectContaining({ triggerTurn: false }),
		);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "anvil-report", content: expect.stringContaining("deterministic check failed") }),
			expect.objectContaining({ triggerTurn: false }),
		);
	});

	it("filters mixed-workflow history strictly by workflow name", async () => {
		const entries = [
			...demoRunEntries("failed"),
			{ type: "custom", customType: "anvil-run", data: { runId: "other-run", workflowName: "other", input: "other task", phase: "run_end", timestamp: "2026-07-08T00:00:00.000Z", finalState: "succeeded" } },
		];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("history demo", ctx);

		const output = String(pi.sendMessage.mock.calls[0]?.[0].content);
		expect(output).toContain("run-prev");
		expect(output).not.toContain("other-run");
	});

	it("notifies for empty sessions and named history or report misses without rendering", async () => {
		const entries: Array<Record<string, unknown>> = [];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("history", ctx);
		await command!.handler("report", ctx);
		await command!.handler("history missing", ctx);
		await command!.handler("report missing-run", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No Anvil runs recorded in this session.", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith('No Anvil runs recorded for workflow "missing" in this session.', "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith('No Anvil run matches "missing-run" in this session.', "info");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("reports an ambiguous run-id prefix without rendering a report and defaults to the newest bounded session run", async () => {
		const entries = [
			...demoRunEntries("failed"),
			{ type: "custom", customType: "anvil-run", data: { runId: "run-present", workflowName: "demo", input: "newest", phase: "run_end", timestamp: "2026-07-08T00:00:00.000Z", finalState: "succeeded" } },
		];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("report run-p", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/ambiguous/i), "warning");
		expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customType: "anvil-report" }), expect.anything());

		await command!.handler("report", ctx);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "anvil-report", content: expect.stringContaining("newest") }),
			expect.objectContaining({ triggerTurn: false }),
		);
	});

	it("keeps history and reports session-scoped when entries contain hostile checkpoint payloads", async () => {
		const secret = "TOKEN=session-secret`|\n<script>[x](javascript:bad)";
		const entries = [{ type: "custom", customType: "anvil-run", data: {
			runId: "hostile-run", workflowName: "demo", input: secret, phase: "run_end", timestamp: "2026-07-08T00:00:00.000Z",
			finalState: "failed", reason: "provider error child diagnostic TOKEN=reason-secret",
		} }];
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("history", ctx);
		await command!.handler("report hostile", ctx);
		const output = pi.sendMessage.mock.calls.map(([message]) => String(message.content)).join("\n");
		expect(output).not.toMatch(/session-secret|reason-secret|<script>|javascript:/);
		expect(output).toContain("[external diagnostic redacted]");
	});

	it("posts sanitized, bounded reports without reading reported paths, resolving symlinks, or launching subprocesses", async () => {
		const entries = Array.from({ length: 2_010 }, (_, index) => ({ type: "custom", customType: "anvil-run", data: {
			runId: "bounded-run", workflowName: "demo", input: "task", phase: "check_result", timestamp: "2026-07-08T00:00:00.000Z",
			stepId: "verify", checkId: `check-${index}`, checkType: "deterministic", pass: true,
			sessionFiles: ["../../etc/passwd", "/does/not/exist", "/home/me/.ssh/id_rsa"],
		} }));
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext("/project", entries);

		await command!.handler("report", ctx);
		const output = String(pi.sendMessage.mock.calls[0]?.[0].content);
		expect(output).toContain("Truncated report data");
		expect(output).not.toContain("id_rsa");
		expect(output.length).toBeLessThan(50_000);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});

describe("/anvil resume command", () => {
	it("shows a numbered step map when no resume step is provided", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("aborted");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume", ctx);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "anvil-resume",
				content: expect.stringMatching(
					/1\.\s+(?:Plan.*plan|plan.*Plan)[\s\S]*2\.\s+(?:Implement.*implement|implement.*Implement)[\s\S]*3\.\s+(?:Verify.*verify|verify.*Verify)/,
				),
			}),
			expect.objectContaining({ triggerTurn: false }),
		);
		const content = String(pi.sendMessage.mock.calls[0]?.[0].content);
		expect(content).toContain("/anvil resume <step> [retry-number]");
		expect(content).toContain("Latest resumable run: `run-prev` (aborted, 2026-07-07T00:04:00.000Z)");
		expect(content).toContain("Last started step: 2. Implement (`implement`) at 2026-07-07T00:02:00.000Z");
		expect(content).toContain("Failure reason: deterministic check failed (2026-07-07T00:03:00.000Z)");
		expect(content).toMatch(/suggest(?:ed|ion)[\s\S]*\/anvil resume 2/i);
		expect(content).toContain("Omit `retry-number` when no retry count should be seeded");
		expect(content).not.toContain("Omit `retry-number` for no retries");
	});

	it("reserves the active run slot before resume discovery and idle waits", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("aborted");
		const { command } = registerAnvilCommand(entries);
		const notifications: Array<{ message: string; type?: string }> = [];
		const idleGate = deferred<void>();
		let idle = false;
		const ctx = {
			...commandContext(project, entries),
			ui: {
				notify: vi.fn((message: string, type?: string) => notifications.push({ message, type })),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
			},
			isIdle: vi.fn(() => idle),
			waitForIdle: vi.fn(async () => {
				await idleGate.promise;
				idle = true;
			}),
		};

		const first = command!.handler("resume 2", ctx);
		const second = command!.handler("resume 3", ctx);
		await waitUntil(() => ctx.waitForIdle.mock.calls.length === 1);
		idleGate.resolve();
		await Promise.all([first, second]);

		expect(notifications.filter((entry) => entry.message.startsWith("Resumed Anvil workflow"))).toHaveLength(1);
		expect(notifications).toContainEqual({ message: "An Anvil workflow is already running in this session.", type: "error" });
	});

	it("resumes the latest aborted run from the requested step and retry count", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("aborted");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume 2 3", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length > 0);

		const instruction = pi.sendUserMessage.mock.calls[0]![0] as string;
		expect(instruction).toContain("step 2/3: Implement");
		expect(instruction).toContain("Implement Resume task; retry 3");
		expect(instruction).not.toContain("Plan Resume task");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Resumed Anvil workflow "demo"'), "info");
	});

	it("resumes with the byte-for-byte original input instead of presentation-sanitized checkpoint text", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("failed").map((checkpoint) => ({
			...checkpoint,
			data: { ...(checkpoint.data as Record<string, unknown>), input: "TOKEN=original-value" },
		}));
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume", ctx);
		expect(String(pi.sendMessage.mock.calls[0]?.[0].content)).not.toContain("original-value");

		await command!.handler("resume 2", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length > 0);

		const instruction = pi.sendUserMessage.mock.calls[0]![0] as string;
		expect(instruction).toContain("Implement TOKEN=original-value");
	});

	it("allows resuming a run that stopped after a breaker failure", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume 3", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length === 2);

		expect(pi.sendUserMessage.mock.calls[0]![0]).toContain("step 2/3: Implement");
		const targetInstruction = pi.sendUserMessage.mock.calls[1]![0] as string;
		expect(targetInstruction).toContain("step 3/3: Verify");
		expect(targetInstruction).toContain("Verify Resume task");
		expect(targetInstruction).not.toContain("retry 1");
	});

	it("rejects an out-of-range step and repeats the numbered step map", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("aborted");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume 4", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/step 4.*out of range/i), "error");
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "anvil-resume", content: expect.stringMatching(/3\.\s+(?:Verify.*verify|verify.*Verify)/) }),
			expect.objectContaining({ triggerTurn: false }),
		);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("Feature 3 Phase 1 resume-across-edits", () => {
	it("suggests and launches the historical last-started step id after insertion, removal, and reordering", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeWorkflowSource(project, `export default { name: "demo", steps: [
			{ id: "verify", prompt: "verify" }, { id: "new", prompt: "new" },
			{ id: "implement", title: "Implement moved", prompt: "implement" },
		] };`);
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume", ctx);
		const map = String(pi.sendMessage.mock.calls[0]?.[0].content);
		expect(map).toContain("3. Implement moved (`implement`) ← suggested resume point");
		expect(map).toContain("/anvil resume 3");

		await command!.handler("resume 3", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length === 3);
		expect(pi.sendUserMessage.mock.calls.map(([instruction]) => String(instruction).match(/step \d+\/3: ([^\n]+)/)?.[1])).toEqual([
			"verify",
			"new",
			"Implement moved",
		]);
	});

	it("rejects a renamed or removed inferred target before idle wait, host creation, or instruction launch", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeWorkflowSource(project, `export default { name: "demo", steps: [{ id: "renamed", prompt: "renamed" }] };`);
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("The prior run's last-started step is not present in the current workflow definition.", "error");
		expect(String(pi.sendMessage.mock.calls[0]?.[0].content)).toContain("1. renamed (`renamed`)");
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps /anvil resume N positional against the current definition and retains its retry seed", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeWorkflowSource(project, `export default { name: "demo", steps: [
			{ id: "implement", prompt: "moved target {loop}" }, { id: "plan", title: "Current second", prompt: "current second {loop}" }
		] };`);
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume 2 3", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length === 2);
		expect(pi.sendUserMessage.mock.calls[0]?.[0]).toContain("step 1/2: implement");
		expect(pi.sendUserMessage.mock.calls[1]?.[0]).toContain("step 2/2: Current second");
		expect(pi.sendUserMessage.mock.calls[1]?.[0]).toContain("current second 3");
	});

	it("does not expose hostile persisted output in notifications, maps, reports, errors, or summaries", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeWorkflowSource(project, `export default { name: "demo", steps: [
			{ id: "plan", prompt: "plan" }, { id: "implement", prompt: "Use {outputs.plan}" }
		] };`);
		const secret = "TOKEN=resume-secret\\n# INJECT [link](javascript:bad) /home/me/.ssh/id_rsa";
		const entries = demoRunEntries("failed");
		(entries[2]!.data as Record<string, unknown>).output = secret;
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume", ctx);
		await command!.handler("history", ctx);
		await command!.handler("report run-prev", ctx);
		const presentation = pi.sendMessage.mock.calls.map(([message]) => String(message.content)).join("\n");
		expect(presentation).not.toContain("resume-secret");

		await command!.handler("resume 2", ctx);
		await waitUntil(() => pi.sendMessage.mock.calls.some(([message]) => message.customType === "anvil-summary"));
		expect(pi.sendUserMessage.mock.calls[0]?.[0]).toContain("resume-secret");
		expect(ctx.ui.notify.mock.calls.flat().join("\n")).not.toContain("resume-secret");
		const summaries = pi.sendMessage.mock.calls.filter(([message]) => message.customType === "anvil-summary").map(([message]) => String(message.content)).join("\n");
		expect(summaries).not.toContain("resume-secret");
	});

	it("does not alter independent-review isolation boundaries during resume recovery", () => {
		expect(INDEPENDENT_REVIEW_TOOL_NAMES).toContain("anvil_verdict");
		expect(INDEPENDENT_REVIEW_TOOL_NAMES).not.toContain("bash");
		expect(INDEPENDENT_REVIEW_MODE).toBe("review");
	});
});

async function writeDemoWorkflow(project: string): Promise<void> {
	const workflowsDir = join(project, ".pi", "anvil", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(
		join(workflowsDir, "demo.ts"),
		`export default {
			name: "demo",
			steps: [
				{ id: "plan", title: "Plan", prompt: "Plan {input}" },
				{ id: "implement", title: "Implement", prompt: "Implement {input}; retry {loop}" },
				{ id: "verify", title: "Verify", prompt: "Verify {input}" },
			],
		};`,
		"utf8",
	);
}

async function writeWorkflowSource(project: string, source: string): Promise<void> {
	const workflowsDir = join(project, ".pi", "anvil", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "demo.ts"), source, "utf8");
}

function demoRunEntries(finalState: "aborted" | "failed") {
	const base = { runId: "run-prev", workflowName: "demo", input: "Resume task", timestamp: "2026-07-07T00:00:00.000Z" };
	return [
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "run_start" } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_start", stepId: "plan", stepIndex: 0, timestamp: "2026-07-07T00:01:00.000Z" } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_pass", stepId: "plan", stepIndex: 0, timestamp: "2026-07-07T00:01:30.000Z" } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_start", stepId: "implement", stepIndex: 1, timestamp: "2026-07-07T00:02:00.000Z" } },
		{
			type: "custom",
			customType: "anvil-run",
			data: {
				...base,
				phase: "check_result",
				stepId: "implement",
				stepIndex: 1,
				checkId: "run-prev:implement:check1:1",
				pass: false,
				reason: "deterministic check failed",
				timestamp: "2026-07-07T00:03:00.000Z",
			},
		},
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "run_end", finalState, timestamp: "2026-07-07T00:04:00.000Z" } },
	];
}

describe("/anvil run --watch (Phase 2)", () => {
	it("parses --watch only in its unambiguous run position and retains legacy run argument parsing", () => {
		expect(__testing__.parseRunArgs("--watch demo do work")).toEqual({ name: "demo", input: "do work", watch: true });
		expect(__testing__.parseRunArgs("demo do work")).toEqual({ name: "demo", input: "do work", watch: false });
		expect(__testing__.parseRunArgs("demo --watch do work")).toEqual({ name: "demo", input: "--watch do work", watch: false });
		expect(__testing__.parseRunArgs("--unknown demo").error).toMatch(/Usage/);
	});

	it("keeps watch opt-in so normal run and resume commands import the workflow only once", async () => {
		const source = await readFile(join(process.cwd(), "src", "index.ts"), "utf8");
		expect(source).toContain("watch ? await pinWorkflowSource(workflow) : undefined");
		expect(source).toContain("reload: pinnedSource ? () => reloadPinnedWorkflow(pinnedSource) : undefined");
		expect(source.match(/reload:/g)).toHaveLength(1);
	});

	it("captures the selected workflow identity, canonical path, source, and trusted root before constructing the reload callback", async () => {
		const source = await readFile(join(process.cwd(), "src", "discovery.ts"), "utf8");
		for (const field of ["file: string", "canonicalFile: string", "trustedRoot: string", "source: WorkflowSource"]) expect(source).toContain(field);
		expect(source).toMatch(/currentFile !== pinned\.canonicalFile/);
	});

	it("reports bounded, sanitized watch warnings without raw loader errors, absolute secret-like paths, or inherited secret-shaped values", async () => {
		const source = await readFile(join(process.cwd(), "src", "engine.ts"), "utf8");
		expect(source).toContain("sanitizeWatchWarning");
		expect(source).toContain("slice(0, 240)");
		expect(source).toContain("[redacted]");
	});

	it("does not weaken independent-review minimal environment, shell startup hardening, mutation-tool allowlist, or realpath-confined cwd after reload", async () => {
		const runner = await readFile(join(process.cwd(), "src", "subagent", "runner.ts"), "utf8");
		expect(runner).toContain('"/usr/bin/env"');
		expect(runner).toContain("/bin/bash --noprofile --norc");
		expect(INDEPENDENT_REVIEW_TOOL_NAMES).not.toContain("edit");
		expect(INDEPENDENT_REVIEW_TOOL_NAMES).not.toContain("write");
	});

	it("does not persist inherited provider or cloud secrets into watch UI messages, checkpoints, or history", async () => {
		const discovery = await readFile(join(process.cwd(), "src", "discovery.ts"), "utf8");
		const engine = await readFile(join(process.cwd(), "src", "engine.ts"), "utf8");
		expect(discovery).not.toMatch(/process\.env/);
		expect(engine).toMatch(/reload callback failed|candidate could not be loaded/);
		expect(engine).not.toMatch(/checkpoint\([^)]*reloadResult\.warning/s);
	});
});

function registerAnvilCommand(entries: Array<Record<string, unknown>>) {
	const events = new Map<string, Array<(...args: any[]) => void>>();
	let command: { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => Promise<any> } | undefined;
	const pi = {
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn((event: string, callback: (...args: any[]) => void) => {
			events.set(event, [...(events.get(event) ?? []), callback]);
		}),
		registerCommand: vi.fn((_name: string, registered: typeof command) => {
			command = registered;
		}),
		sendUserMessage: vi.fn(() => {
			for (const callback of events.get("agent_start") ?? []) callback();
			for (const callback of events.get("agent_end") ?? []) callback();
		}),
		sendMessage: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
		getThinkingLevel: vi.fn(() => "medium"),
		setThinkingLevel: vi.fn(),
		setModel: vi.fn(async () => true),
	} as any;
	piAnvil(pi);
	return { command, pi, events };
}

function commandContext(project: string, entries: Array<Record<string, unknown>>) {
	return {
		cwd: project,
		model: { provider: "openai", id: "default" },
		modelRegistry: { getAll: () => [{ provider: "openai", id: "default" }] },
		ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
		isIdle: vi.fn(() => true),
		waitForIdle: vi.fn(),
		hasPendingMessages: vi.fn(() => false),
		abort: vi.fn(),
		sessionManager: { getEntries: vi.fn(() => entries) },
	};
}

function padToLength(value: string, length: number): string {
	if (value.length > length) throw new Error("value is longer than requested length");
	return value + " ".repeat(length - value.length);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not met before timeout");
}

function restoreEnv(name: "HERDR_ENV" | "CMUX_SHELL_INTEGRATION", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
