import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnvilAutocompleteProvider, getAnvilCompletions } from "../src/index.ts";

let root: string;
let project: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "anvil-completions-"));
	project = join(root, "project");
	await mkdir(join(project, ".pi", "anvil", "workflows"), { recursive: true });
	await writeFile(
		join(project, ".pi", "anvil", "workflows", "feature-forge.ts"),
		`export default { name: "feature-forge", steps: [{ id: "one", prompt: "forge" }] };`,
		"utf8",
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("getAnvilCompletions", () => {
	it("returns all workflow completions after a validate subcommand and space", async () => {
		const completions = await getAnvilCompletions("validate ", project);

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: "validate feature-forge",
				label: "feature-forge",
			}),
		);
	});

	it("returns a full validate argument replacement for workflow completions", async () => {
		const completions = await getAnvilCompletions("validate feature", project);

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: "validate feature-forge",
				label: "feature-forge",
			}),
		);
	});

	it("returns a full run argument replacement for workflow completions", async () => {
		const completions = await getAnvilCompletions("run feature", project);

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: "run feature-forge",
				label: "feature-forge",
			}),
		);
	});

	it("keeps subcommand completions as bare subcommands", async () => {
		const completions = await getAnvilCompletions("val", project);

		expect(completions).toEqual([{ value: "validate", label: "validate" }]);
		expect(await getAnvilCompletions("hist", project)).toEqual([{ value: "history", label: "history" }]);
	});

	it("keeps report as a bare subcommand completion and does not expose cross-session run identifiers", async () => {
		expect(await getAnvilCompletions("rep", project)).toEqual([{ value: "report", label: "report" }]);
		expect(await getAnvilCompletions("report run-", project)).toBeNull();
	});

	it("completes workflow names for history", async () => {
		const completions = await getAnvilCompletions("history feature", project);

		expect(completions).toContainEqual(expect.objectContaining({ value: "history feature-forge", label: "feature-forge" }));
	});

	it("does not re-import workflow modules on repeated completion keystrokes without file changes", async () => {
		const counterFile = join(root, "imports.txt");
		await writeFile(counterFile, "0", "utf8");
		await writeFile(
			join(project, ".pi", "anvil", "workflows", "side-effect.ts"),
			`import { readFileSync, writeFileSync } from "node:fs";
			const counterFile = ${JSON.stringify(counterFile)};
			writeFileSync(counterFile, String(Number(readFileSync(counterFile, "utf8")) + 1));
			export default { name: "side-effect", steps: [{ id: "one", prompt: "side" }] };`,
			"utf8",
		);

		await getAnvilCompletions("run side", project);
		await getAnvilCompletions("run side", project);

		expect(await readFile(counterFile, "utf8")).toBe("1");
	});
});

describe("createAnvilAutocompleteProvider", () => {
	it("returns workflow suggestions for forced tab completion after validate", async () => {
		const current = createDirectoryFallbackProvider();
		const provider = createAnvilAutocompleteProvider(current, project);

		const suggestions = await provider.getSuggestions(["/anvil validate "], 0, "/anvil validate ".length, {
			force: true,
			signal: new AbortController().signal,
		});

		expect(suggestions?.prefix).toBe("validate ");
		expect(suggestions?.items).toContainEqual(
			expect.objectContaining({ value: "validate feature-forge", label: "feature-forge" }),
		);
	});

	it("delegates non-Anvil completion to the wrapped provider", async () => {
		const current = createDirectoryFallbackProvider();
		const provider = createAnvilAutocompleteProvider(current, project);

		const suggestions = await provider.getSuggestions(["look here "], 0, "look here ".length, {
			force: true,
			signal: new AbortController().signal,
		});

		expect(suggestions?.items).toEqual([{ value: "src/", label: "src/" }]);
	});

	it("delegates once workflow completion no longer applies", async () => {
		const current = createDirectoryFallbackProvider();
		const provider = createAnvilAutocompleteProvider(current, project);
		const line = "/anvil run feature-forge task ";

		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			force: true,
			signal: new AbortController().signal,
		});

		expect(suggestions?.items).toEqual([{ value: "src/", label: "src/" }]);
	});
});

function createDirectoryFallbackProvider() {
	return {
		async getSuggestions() {
			return { prefix: "", items: [{ value: "src/", label: "src/" }] };
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return { lines, cursorLine, cursorCol };
		},
	};
}
