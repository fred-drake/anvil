import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/validate.ts";

const validWorkflow = {
	name: "demo-workflow",
	steps: [{ id: "one", prompt: "Do {input}" }],
};

describe("validateWorkflow", () => {
	it("accepts a minimal valid workflow", () => {
		expect(validateWorkflow(validWorkflow)).toEqual({ ok: true, workflow: validWorkflow });
	});

	it("rejects duplicate step ids", () => {
		const result = validateWorkflow({
			name: "dups",
			steps: [
				{ id: "same", prompt: "a" },
				{ id: "same", prompt: "b" },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain('duplicate step id "same"');
	});

	it("rejects dangling goto targets", () => {
		const result = validateWorkflow({
			name: "dangling",
			steps: [
				{
					id: "one",
					prompt: "a",
					checks: [{ type: "deterministic", command: "false", onFail: { goto: "missing" } }],
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toContain('goto target "missing" does not exist');
	});

	it("rejects defaults goto targets that do not exist", () => {
		const result = validateWorkflow({
			name: "dangling-default",
			defaults: { onFail: { goto: "missing" } },
			steps: [{ id: "one", prompt: "a" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain('workflow.defaults.onFail.goto target "missing" does not exist');
	});

	it("rejects malformed checks", () => {
		const result = validateWorkflow({
			name: "bad-check",
			steps: [{ id: "one", prompt: "a", checks: [{ type: "deterministic" }] }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toContain("command must be a string or function");
	});

	it("rejects invalid workflow names", () => {
		const result = validateWorkflow({ name: "Bad Name", steps: [{ id: "one", prompt: "a" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain("workflow.name must match /^[a-z0-9-]+$/");
	});

	it("accepts workflow and step delegation settings", () => {
		const workflow = {
			name: "delegation",
			defaults: { delegation: { skill: "implementer" } },
			steps: [{ id: "one", prompt: "a", delegation: "auto" }],
		};
		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it("accepts cmux subagent delegation settings", () => {
		const workflow = {
			name: "subagent-delegation",
			defaults: { delegation: { subagent: "cmux" } },
			steps: [{ id: "one", prompt: "a", delegation: { subagent: "cmux" } }],
		};
		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it("rejects unsupported subagent backends", () => {
		const result = validateWorkflow({
			name: "bad-subagent",
			steps: [{ id: "one", prompt: "a", delegation: { subagent: "tmux" } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain('workflow.steps[0].delegation.subagent must be "cmux"');
	});

	it("accepts per-step model and thinking-level settings", () => {
		const workflow = {
			name: "model-selection",
			steps: [
				{ id: "model-shorthand", prompt: "a", model: "openai-codex/gpt-5.5:high" },
				{ id: "model-explicit", prompt: "b", model: "openai-codex/gpt-5.5", thinkingLevel: "xhigh" },
				{ id: "thinking-only", prompt: "c", thinkingLevel: "off" },
			],
		};
		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it("rejects malformed per-step model and thinking-level settings", () => {
		const result = validateWorkflow({
			name: "bad-model-selection",
			steps: [
				{ id: "one", prompt: "a", model: "", thinkingLevel: "deep" },
				{ id: "two", prompt: "b", model: 42 },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.steps[0].model must be a non-empty string when provided");
			expect(result.errors).toContain("workflow.steps[1].model must be a non-empty string when provided");
			expect(result.errors).toContain(
				'workflow.steps[0].thinkingLevel must be one of "off", "minimal", "low", "medium", "high", or "xhigh" when provided',
			);
		}
	});

	it("rejects malformed delegation settings", () => {
		const result = validateWorkflow({
			name: "bad-delegation",
			defaults: { delegation: "subagent" },
			steps: [{ id: "one", prompt: "a", delegation: { skill: "" } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain(
				'workflow.defaults.delegation must be "auto", "none", { skill: string }, or { subagent: "cmux" }',
			);
			expect(result.errors).toContain("workflow.steps[0].delegation.skill must be a non-empty string");
		}
	});

	it("rejects malformed defaults", () => {
		expect(validateWorkflow({ name: "bad-defaults", defaults: "nope", steps: [{ id: "one", prompt: "a" }] })).toEqual({
			ok: false,
			errors: ["workflow.defaults must be an object when provided"],
		});

		const result = validateWorkflow({
			name: "bad-default-fields",
			defaults: { agent: 1, maxLoops: -1, onFail: { goto: "", maxLoops: 1.2, onExhausted: "later", feedback: "yes" } },
			steps: [{ id: "one", prompt: "a" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.defaults.agent must be a string when provided");
			expect(result.errors).toContain("workflow.defaults.maxLoops must be a non-negative integer when provided");
			expect(result.errors).toContain("workflow.defaults.onFail.goto must be a non-empty string");
			expect(result.errors).toContain("workflow.defaults.onFail.maxLoops must be a non-negative integer when provided");
			expect(result.errors).toContain('workflow.defaults.onFail.onExhausted must be "stop" or "continue" when provided');
			expect(result.errors).toContain("workflow.defaults.onFail.feedback must be a boolean when provided");
		}
	});

	it("rejects unknown keys at every workflow config level", () => {
		const result = validateWorkflow({
			name: "unknown-keys",
			onfail: "continue",
			defaults: { maxloops: 2, onFail: { goto: "one", maxloops: 1 } },
			steps: [
				{
					id: "one",
					prompt: "a",
					skipif: () => false,
					onFail: { goto: "one", onexhausted: "continue" },
					checks: [
						{
							type: "agent",
							prompt: "criteria",
							check: "spelling mistake for checks",
							onFail: { goto: "one", maxloops: 1 },
						},
					],
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.onfail is not recognized");
			expect(result.errors).toContain("workflow.defaults.maxloops is not recognized");
			expect(result.errors).toContain("workflow.defaults.onFail.maxloops is not recognized");
			expect(result.errors).toContain("workflow.steps[0].skipif is not recognized");
			expect(result.errors).toContain("workflow.steps[0].onFail.onexhausted is not recognized");
			expect(result.errors).toContain("workflow.steps[0].checks[0].check is not recognized");
			expect(result.errors).toContain("workflow.steps[0].checks[0].onFail.maxloops is not recognized");
		}
	});

	it("rejects malformed step fields and check containers", () => {
		const result = validateWorkflow({
			name: "bad-step-fields",
			steps: [
				"not-step",
				{ id: "", title: 1, prompt: 3, agent: 4, runInMain: "yes", skipIf: "no", checks: "nope", onFail: [] },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.steps[0] must be an object");
			expect(result.errors).toContain("workflow.steps[1].id must be a non-empty string");
			expect(result.errors).toContain("workflow.steps[1].title must be a string when provided");
			expect(result.errors).toContain("workflow.steps[1].prompt must be a string or function");
			expect(result.errors).toContain("workflow.steps[1].agent must be a string when provided");
			expect(result.errors).toContain("workflow.steps[1].runInMain must be a boolean when provided");
			expect(result.errors).toContain("workflow.steps[1].skipIf must be a function when provided");
			expect(result.errors).toContain('workflow.steps[1].onFail must be "stop", "continue", or a goto object');
			expect(result.errors).toContain("workflow.steps[1].checks must be an array when provided");
		}
	});

	it("rejects malformed agent checks and check metadata", () => {
		const result = validateWorkflow({
			name: "bad-agent-check",
			steps: [
				{
					id: "one",
					prompt: "a",
					checks: [
						"not-check",
						{ type: "agent", id: "", name: 1, prompt: 2, agent: 3, onFail: { goto: "missing" } },
						{ type: "wat" },
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.steps[0].checks[0] must be an object");
			expect(result.errors).toContain("workflow.steps[0].checks[1].id must be a non-empty string when provided");
			expect(result.errors).toContain("workflow.steps[0].checks[1].name must be a string when provided");
			expect(result.errors).toContain('workflow.steps[0].checks[1].onFail.goto target "missing" does not exist');
			expect(result.errors).toContain("workflow.steps[0].checks[1].prompt must be a string or function");
			expect(result.errors).toContain("workflow.steps[0].checks[1].agent must be a string when provided");
			expect(result.errors).toContain('workflow.steps[0].checks[2].type must be "deterministic" or "agent"');
		}
	});
});
