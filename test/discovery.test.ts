import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWorkflows, pinWorkflowSource, reloadPinnedWorkflow } from "../src/discovery.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "anvil-discovery-"));
	home = join(root, "home");
	project = join(root, "project");
	await mkdir(join(home, ".pi", "agent", "anvil", "workflows"), { recursive: true });
	await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("discoverWorkflows", () => {
	it("loads workflows and lets project definitions win name collisions", async () => {
		await writeWorkflow(home, "demo.ts", `export default { name: "demo", description: "user", steps: [{ id: "one", prompt: "user" }] };`);
		await writeWorkflow(project, "demo.ts", `export default { name: "demo", description: "project", steps: [{ id: "one", prompt: "project" }] };`);

		const workflows = await discoverWorkflows({ homeDir: home, cwd: project });

		expect(workflows).toHaveLength(1);
		expect(workflows[0]?.source).toBe("project");
		expect(workflows[0]?.workflow?.description).toBe("project");
	});

	it("surfaces same-directory workflow name collisions instead of silently dropping one", async () => {
		await writeWorkflow(project, "alpha.ts", `export default { name: "collision", description: "alpha", steps: [{ id: "one", prompt: "alpha" }] };`);
		await writeWorkflow(project, "omega.ts", `export default { name: "collision", description: "omega", steps: [{ id: "one", prompt: "omega" }] };`);

		const workflows = await discoverWorkflows({ homeDir: home, cwd: project, useCache: false });

		expect(workflows.filter((workflow) => workflow.name === "collision")).toHaveLength(2);
		expect(workflows).toContainEqual(
			expect.objectContaining({
				name: "collision",
				file: expect.stringContaining("alpha.ts"),
				errors: expect.arrayContaining([expect.stringMatching(/duplicate|collision|shadow/i)]),
			}),
		);
		expect(workflows).toContainEqual(
			expect.objectContaining({
				name: "collision",
				file: expect.stringContaining("omega.ts"),
				workflow: expect.objectContaining({ description: "omega" }),
			}),
		);
	});

	it("includes load errors in discovery results", async () => {
		await writeWorkflow(home, "broken.ts", `throw new Error("boom");`);

		const workflows = await discoverWorkflows({ homeDir: home, cwd: project });

		expect(workflows[0]?.name).toBe("broken");
		expect(workflows[0]?.errors?.join("\n")).toContain("boom");
	});

	it("loads plain-object default exports", async () => {
		await writeWorkflow(home, "plain.ts", `export default { name: "plain", steps: [{ id: "one", prompt: "plain" }] };`);

		const workflows = await discoverWorkflows({ homeDir: home, cwd: project });

		expect(workflows[0]?.workflow?.name).toBe("plain");
	});

	it("resolves the anvil alias from a temp home workflow", async () => {
		await writeWorkflow(
			home,
			"alias.ts",
			`import { defineWorkflow } from "anvil";
			export default defineWorkflow({ name: "alias", steps: [{ id: "one", prompt: "alias" }] });`,
		);

		const workflows = await discoverWorkflows({ homeDir: home, cwd: project });

		expect(workflows[0]?.errors).toBeUndefined();
		expect(workflows[0]?.workflow?.name).toBe("alias");
	});
});

describe("watched workflow source loading (Phase 2)", () => {
	it("does not re-import unchanged sources at outer boundaries", async () => {
		const counterKey = `__anvil_watch_imports_${Date.now()}`;
		await writeWorkflow(project, "watched.ts", `const state = globalThis as Record<string, number>; state["${counterKey}"] = (state["${counterKey}"] ?? 0) + 1; export default { name: "watched", steps: [{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }] };`);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false })).find((item) => item.name === "watched")!;
		const pinned = await pinWorkflowSource(selected);
		expect((globalThis as Record<string, number>)[counterKey]).toBe(1);
		expect(await reloadPinnedWorkflow(pinned)).toEqual({});
		expect(await reloadPinnedWorkflow(pinned)).toEqual({});
		expect((globalThis as Record<string, number>)[counterKey]).toBe(1);
		delete (globalThis as Record<string, number>)[counterKey];
	});

	it("adopts a captured helper update after its filesystem signature changes", async () => {
		const dir = join(project, ".pi", "anvil", "workflows");
		await writeFile(join(dir, "helper.ts"), `export const message = "first";`, "utf8");
		await writeWorkflow(project, "watched.ts", `import { message } from "./helper.ts"; export default { name: "watched", steps: [{ id: "one", prompt: () => message }] };`);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false })).find((item) => item.name === "watched")!;
		const pinned = await pinWorkflowSource(selected);
		expect(await reloadPinnedWorkflow(pinned)).toEqual({});
		await writeFile(join(dir, "helper.ts"), `export const message = "second value";`, "utf8");
		const changed = await reloadPinnedWorkflow(pinned);
		expect(await (changed.workflow?.steps[0]?.prompt as () => string)()).toBe("second value");
	});

	it("does not rediscover or execute sibling workflow modules while watching", async () => {
		await writeWorkflow(project, "watched.ts", `export default { name: "watched", steps: [{ id: "one", prompt: "safe" }] };`);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false })).find((item) => item.name === "watched")!;
		await writeWorkflow(project, "sibling.ts", `throw new Error("must not execute");`);
		const pinned = await pinWorkflowSource(selected);
		await writeWorkflow(project, "watched.ts", `export default { name: "watched", steps: [{ id: "one", prompt: "changed" }] };`);
		expect((await reloadPinnedWorkflow(pinned)).workflow?.name).toBe("watched");
	});

	it("pins the selected canonical file and trusted workflow root before each reload", async () => {
		await writeWorkflow(project, "watched.ts", `export default { name: "watched", steps: [{ id: "one", prompt: "safe" }] };`);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false }))[0]!;
		const pinned = await pinWorkflowSource(selected);
		expect(pinned.canonicalFile).toContain("watched.ts");
		expect(pinned.canonicalFile.startsWith(pinned.trustedRoot)).toBe(true);
	});

	it("rejects a symlink retarget or replacement outside the trusted root without replacing the active definition", async () => {
		const dir = join(project, ".pi", "anvil", "workflows");
		await writeFile(join(dir, "inside.ts"), `export default { name: "watched", steps: [{ id: "one", prompt: "safe" }] };`, "utf8");
		const link = join(dir, "watched.ts");
		await symlink(join(dir, "inside.ts"), link);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false })).find((item) => item.file === link)!;
		const pinned = await pinWorkflowSource(selected);
		const outside = join(root, "outside.ts");
		await writeFile(outside, `export default { name: "watched", steps: [{ id: "one", prompt: "unsafe" }] };`, "utf8");
		await unlink(link);
		await symlink(outside, link);
		const result = await reloadPinnedWorkflow(pinned);
		expect(result.workflow).toBeUndefined();
		expect(result.warning).toMatch(/identity changed/);
	});

	it("returns bounded, redacted reload diagnostics for load and validation failures without exposing secret-like paths or values", async () => {
		await writeWorkflow(project, "watched.ts", `export default { name: "watched", steps: [{ id: "one", prompt: "safe" }] };`);
		const selected = (await discoverWorkflows({ homeDir: home, cwd: project, useCache: false }))[0]!;
		const pinned = await pinWorkflowSource(selected);
		await writeFile(selected.file, `throw new Error("API_KEY=sk-abcdefghijklmnopqrstuvwxyz /home/me/.ssh/id_rsa");`, "utf8");
		const warning = (await reloadPinnedWorkflow(pinned)).warning ?? "";
		expect(warning.length).toBeLessThan(100);
		expect(warning).not.toMatch(/sk-|id_rsa|API_KEY/);
	});
});

async function writeWorkflow(scopeRoot: string, fileName: string, content: string): Promise<void> {
	const dir = scopeRoot === home ? join(home, ".pi", "agent", "anvil", "workflows") : join(project, ".pi", "anvil", "workflows");
	await writeFile(join(dir, fileName), content, "utf8");
}
