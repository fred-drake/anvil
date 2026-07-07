import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflowFile } from "../src/discovery.ts";
import { resolveStepModelSelection } from "../src/engine.ts";
import { defineWorkflow, type WorkflowDefinition } from "../src/types.ts";

describe("workflow public contract", () => {
	it("exposes per-step model selection fields", () => {
		const workflow: WorkflowDefinition = defineWorkflow({
			name: "model-contract",
			steps: [
				{ id: "shorthand", prompt: "Use the shorthand", model: "openai-codex/gpt-5.5:high" },
				{ id: "explicit", prompt: "Use explicit thinking", model: "openai-codex/gpt-5.5", thinkingLevel: "xhigh" },
			],
		});

		expect(workflow.steps[0]?.model).toBe("openai-codex/gpt-5.5:high");
		expect(workflow.steps[1]?.thinkingLevel).toBe("xhigh");
	});

	it("parses pi's colon thinking shorthand without treating slash as a thinking separator", () => {
		expect(resolveStepModelSelection({ id: "one", prompt: "a", model: "openai-codex/gpt-5.5:high" })).toEqual({
			model: "openai-codex/gpt-5.5",
			thinkingLevel: "high",
		});
		expect(resolveStepModelSelection({ id: "two", prompt: "b", model: "openai-codex/gpt-5.5/high" })).toEqual({
			model: "openai-codex/gpt-5.5/high",
		});
		expect(resolveStepModelSelection({ id: "three", prompt: "c", model: "router/model:exacto" })).toEqual({
			model: "router/model:exacto",
		});
	});

	it("loads the dogfood feature-forge workflow", async () => {
		const file = fileURLToPath(new URL("../.pi/anvil/workflows/feature-forge.ts", import.meta.url));

		const result = await loadWorkflowFile(file, "project");

		expect(result.errors).toBeUndefined();
		expect(result.workflow?.name).toBe("feature-forge");
	});

	it("keeps feature-forge prompts aligned with this TypeScript/Vitest repository", () => {
		const source = readFileSync(new URL("../.pi/anvil/workflows/feature-forge.ts", import.meta.url), "utf8");

		expect(source).not.toMatch(/XCTest|SwiftUI|CLI\/GUI parity/);
		expect(source).not.toContain("docs/ISSUES.md");
		expect(source).toContain("docs/ISSUE.md");
		expect(source).toMatch(/Vitest|test\/.*\.test\.ts|TypeScript/);
		expect(source).toContain("npx vitest run --coverage");
		expect(source).not.toContain("npm test -- --coverage");
	});
});
