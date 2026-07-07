import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAnvil from "../src/index.ts";

const ORIGINAL_HERDR_ENV = process.env.HERDR_ENV;
const ORIGINAL_CMUX_SHELL_INTEGRATION = process.env.CMUX_SHELL_INTEGRATION;

let root: string | undefined;

beforeEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.CMUX_SHELL_INTEGRATION;
});

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
	restoreEnv("HERDR_ENV", ORIGINAL_HERDR_ENV);
	restoreEnv("CMUX_SHELL_INTEGRATION", ORIGINAL_CMUX_SHELL_INTEGRATION);
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
		expect(pi.sendMessage.mock.calls[0]?.[0].content).toContain("/anvil resume <step> [retry-number]");
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

	it("allows resuming a run that stopped after a breaker failure", async () => {
		root = await mkdtemp(join(tmpdir(), "anvil-command-"));
		const project = join(root, "project");
		await writeDemoWorkflow(project);
		const entries = demoRunEntries("failed");
		const { command, pi } = registerAnvilCommand(entries);
		const ctx = commandContext(project, entries);

		await command!.handler("resume 3", ctx);
		await waitUntil(() => pi.sendUserMessage.mock.calls.length > 0);

		const instruction = pi.sendUserMessage.mock.calls[0]![0] as string;
		expect(instruction).toContain("step 3/3: Verify");
		expect(instruction).toContain("Verify Resume task");
		expect(instruction).not.toContain("retry 1");
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

function demoRunEntries(finalState: "aborted" | "failed") {
	const base = { runId: "run-prev", workflowName: "demo", input: "Resume task", timestamp: "2026-07-07T00:00:00.000Z" };
	return [
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "run_start" } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_start", stepId: "plan", stepIndex: 0 } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_pass", stepId: "plan", stepIndex: 0 } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "step_start", stepId: "implement", stepIndex: 1 } },
		{ type: "custom", customType: "anvil-run", data: { ...base, phase: "run_end", finalState } },
	];
}

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
	return { command, pi };
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
