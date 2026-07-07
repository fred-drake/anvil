import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflowFile } from "../src/discovery.ts";
import { resolveStepModelSelection, type StepModelSelection } from "../src/engine.ts";
import { workflowSubagentBackends } from "../src/prompts.ts";
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

	it("exposes retry-based model selection fields", () => {
		const workflow = defineWorkflow({
			name: "retry-model-contract",
			steps: [
				{
					id: "implement",
					prompt: "Use retry-aware model selection",
					model: "cheap/model:minimal",
					retryModelSelections: [{ retry: 1, model: "strong/model", thinkingLevel: "high" }],
				},
			],
		});
		const source = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");

		expect((workflow.steps[0] as any).retryModelSelections).toEqual([
			{ retry: 1, model: "strong/model", thinkingLevel: "high" },
		]);
		expect(source).toMatch(/export\s+interface\s+WorkflowModelSelection/);
		expect(source).toMatch(/export\s+interface\s+WorkflowRetryModelSelection/);
		expect(source).toMatch(/retry\s*:\s*number/);
		expect(source).toMatch(/retryModelSelections\??\s*:\s*WorkflowRetryModelSelection\[\]/);
	});

	it("exposes herdr as a supported declarative subagent backend", () => {
		const workflow = defineWorkflow({
			name: "herdr-contract",
			defaults: { delegation: { subagent: "herdr" } },
			steps: [{ id: "one", prompt: "Use herdr" }],
		});
		const source = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");

		expect(workflow.defaults?.delegation).toEqual({ subagent: "herdr" });
		expect(source).toMatch(/WorkflowSubagentBackend\s*=\s*["']cmux["']\s*\|\s*["']herdr["']/);
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

	it("resolves retry-based model selections with fallback and threshold semantics", () => {
		const resolve = resolveStepModelSelection as unknown as (
			step: WorkflowDefinition["steps"][number],
			retryCount?: number,
		) => StepModelSelection | undefined;
		const step = {
			id: "implement",
			prompt: "a",
			model: "cheap/model:minimal",
			retryModelSelections: [
				{ retry: 1, model: "strong/model", thinkingLevel: "high" },
				{ retry: 3, model: "strongest/model:xhigh", thinkingLevel: "medium" },
			],
		};

		expect(resolve(step, 0)).toEqual({ model: "cheap/model", thinkingLevel: "minimal" });
		expect(resolve(step, 1)).toEqual({ model: "strong/model", thinkingLevel: "high" });
		expect(resolve(step, 2)).toEqual({ model: "strong/model", thinkingLevel: "high" });
		expect(resolve(step, 3)).toEqual({ model: "strongest/model", thinkingLevel: "medium" });
	});

	it("reports auto-detected default subagent backends for workflow preflight", () => {
		withSubagentEnv({ CMUX_SHELL_INTEGRATION: "1" }, () => {
			expect(workflowSubagentBackends(defineWorkflow({ name: "default-auto", steps: [{ id: "one", prompt: "a" }] }))).toEqual([
				"cmux",
			]);
		});

		withSubagentEnv({ HERDR_ENV: "1", CMUX_SHELL_INTEGRATION: "1" }, () => {
			expect(
				workflowSubagentBackends(
					defineWorkflow({ name: "explicit-auto", defaults: { delegation: "auto" }, steps: [{ id: "one", prompt: "a" }] }),
				),
			).toEqual(["herdr"]);
		});
	});

	it("loads the dogfood feature-forge workflow", async () => {
		const file = fileURLToPath(new URL("../.pi/anvil/workflows/feature-forge.ts", import.meta.url));

		const result = await loadWorkflowFile(file, "project");

		expect(result.errors).toBeUndefined();
		expect(result.workflow?.name).toBe("feature-forge");
	});

	it("documents herdr alongside cmux in the README", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

		expect(readme).toContain('delegation: { subagent: "cmux" }');
		expect(readme).toContain('delegation: { subagent: "herdr" }');
		expect(readme).toMatch(/herdr/i);
	});

	it("documents auto-detected subagent defaults in the README", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

		expect(readme).toContain('delegation: "auto"');
		expect(readme).toMatch(/default[^\n]+auto|auto[^\n]+default/i);
		expect(readme).toContain("HERDR_ENV=1");
		expect(readme).toContain("CMUX_SHELL_INTEGRATION=1");
	});

	it("documents retry-based subagent model selection in the README", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

		expect(readme).toContain("retryModelSelections");
		expect(readme).toMatch(/retry\s*:\s*0[^\n]+first attempt|first attempt[^\n]+retry\s*:\s*0/i);
		expect(readme).toMatch(/highest[^\n]+retry[^\n]+less than or equal|less than or equal[^\n]+retry[^\n]+wins/i);
		expect(readme).toMatch(/subagent[\s\S]{0,240}model|model[\s\S]{0,240}subagent/i);
	});

	it("keeps the workflow builder skill aligned with supported subagent backends", () => {
		const source = readFileSync(new URL("../skills/anvil-workflow-builder/SKILL.md", import.meta.url), "utf8");

		expect(source).toContain('delegation: { subagent: "cmux" }');
		expect(source).toContain('delegation: { subagent: "herdr" }');
		expect(source).toContain('delegation: "auto"');
		expect(source).toContain("HERDR_ENV=1");
		expect(source).toContain("CMUX_SHELL_INTEGRATION=1");
		expect(source).toMatch(/default[^\n]+delegation:\s*"auto"|delegation:\s*"auto"[^\n]+default/i);
	});

	it("keeps the workflow builder skill aligned with retry-based model selection", () => {
		const source = readFileSync(new URL("../skills/anvil-workflow-builder/SKILL.md", import.meta.url), "utf8");

		expect(source).toContain("retryModelSelections");
		expect(source).toMatch(/retry\s*:\s*0[^\n]+first attempt|first attempt[^\n]+retry\s*:\s*0/i);
		expect(source).toMatch(/retry[\s\S]{0,240}model|model[\s\S]{0,240}retry/i);
	});

	it("keeps workflow examples aligned with auto-detected subagent defaults", () => {
		const demo = readFileSync(new URL("../examples/workflows/demo.ts", import.meta.url), "utf8");
		const featureForge = readFileSync(new URL("../.pi/anvil/workflows/feature-forge.ts", import.meta.url), "utf8");

		expect(demo).toContain('delegation: "auto"');
		expect(featureForge).toContain('delegation: "auto"');
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

	it("exposes a public runWorkflow resume contract", () => {
		const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

		expect(source).toMatch(/export\s+interface\s+ResumeWorkflowOptions/);
		expect(source).toMatch(/stepNumber\s*:\s*number/);
		expect(source).toMatch(/retryCount\??\s*:\s*number/);
		expect(source).toMatch(/resume\??\s*:\s*ResumeWorkflowOptions/);
	});

	it("documents the resume command and numbered step selection in the README", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

		expect(readme).toContain("/anvil resume <step> [retry-number]");
		expect(readme).toMatch(/resume[\s\S]*(numbered|step\s+number|1\.)[\s\S]*(retry-number|retry count)/i);
	});
});

type AutoSubagentEnv = Partial<Record<"HERDR_ENV" | "CMUX_SHELL_INTEGRATION", string>>;

function withSubagentEnv(env: AutoSubagentEnv, fn: () => void): void {
	const previous: AutoSubagentEnv = {
		HERDR_ENV: process.env.HERDR_ENV,
		CMUX_SHELL_INTEGRATION: process.env.CMUX_SHELL_INTEGRATION,
	};
	delete process.env.HERDR_ENV;
	delete process.env.CMUX_SHELL_INTEGRATION;
	if (env.HERDR_ENV !== undefined) process.env.HERDR_ENV = env.HERDR_ENV;
	if (env.CMUX_SHELL_INTEGRATION !== undefined) process.env.CMUX_SHELL_INTEGRATION = env.CMUX_SHELL_INTEGRATION;

	try {
		fn();
	} finally {
		restoreEnv("HERDR_ENV", previous.HERDR_ENV);
		restoreEnv("CMUX_SHELL_INTEGRATION", previous.CMUX_SHELL_INTEGRATION);
	}
}

function restoreEnv(name: keyof AutoSubagentEnv, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
