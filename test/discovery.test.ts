import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWorkflows } from "../src/discovery.ts";

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

async function writeWorkflow(scopeRoot: string, fileName: string, content: string): Promise<void> {
	const dir = scopeRoot === home ? join(home, ".pi", "agent", "anvil", "workflows") : join(project, ".pi", "anvil", "workflows");
	await writeFile(join(dir, fileName), content, "utf8");
}
