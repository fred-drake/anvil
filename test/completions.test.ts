import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

		expect(suggestions).toEqual({
			prefix: "validate ",
			items: [expect.objectContaining({ value: "validate feature-forge", label: "feature-forge" })],
		});
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
