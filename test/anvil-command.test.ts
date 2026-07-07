import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piAnvil from "../src/index.ts";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
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
