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

	it("rejects duplicate check ids across workflow steps", () => {
		const result = validateWorkflow({
			name: "duplicate-checks",
			steps: [
				{
					id: "first",
					prompt: "a",
					checks: [{ type: "deterministic", id: "quality", command: "true" }],
				},
				{
					id: "second",
					prompt: "b",
					checks: [{ type: "agent", id: "quality", prompt: "review it" }],
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain('duplicate check id "quality"');
	});

	it("accepts agent check timeout settings", () => {
		const workflow = {
			name: "agent-timeout",
			steps: [
				{
					id: "review",
					prompt: "review",
					checks: [{ type: "agent", prompt: "criteria", timeoutMs: 42 }],
				},
			],
		};

		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it.each([
		["workflow.defaults.delegation", { defaults: { delegation: "auto" } }],
		["workflow.defaults.agent", { defaults: { agent: "implementer" } }],
		["workflow.defaults.subagentTimeoutMs", { defaults: { subagentTimeoutMs: 1_000 } }],
		["workflow.steps[0].delegation", { steps: [{ id: "one", prompt: "a", delegation: { subagent: "cmux" } }] }],
		["workflow.steps[0].agent", { steps: [{ id: "one", prompt: "a", agent: "reviewer" }] }],
		["workflow.steps[0].runInMain", { steps: [{ id: "one", prompt: "a", runInMain: true }] }],
		["workflow.steps[0].subagentTimeoutMs", { steps: [{ id: "one", prompt: "a", subagentTimeoutMs: 1_000 }] }],
		["workflow.steps[0].checks[0].agent", {
			steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", agent: "reviewer" }] }],
		}],
		["workflow.steps[0].checks[0].review", {
			steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", review: { subagent: "auto" } }] }],
		}],
		["workflow.steps[0].checks[0].reviewFallback", {
			steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", reviewFallback: "fail" }] }],
		}],
	])("rejects removed field %s with prompt migration guidance", (path, patch) => {
		const workflow = {
			name: "removed-subagent-field",
			steps: [{ id: "one", prompt: "a" }],
			...patch,
		};
		const result = validateWorkflow(workflow);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain(
				`${path} was removed; describe desired subagent behavior directly in the step or agent-check prompt`,
			);
		}
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

	it("accepts outputFrom when it references a check on the same step", () => {
		const workflow = {
			name: "output-from",
			steps: [
				{
					id: "build",
					prompt: "build",
					checks: [{ type: "deterministic", id: "artifact", command: "echo dist/app.js" }],
					outputFrom: "artifact",
				},
			],
		};

		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it("rejects outputFrom when it does not reference a same-step check id", () => {
		const result = validateWorkflow({
			name: "bad-output-from",
			steps: [
				{
					id: "build",
					prompt: "build",
					checks: [{ type: "deterministic", id: "artifact", command: "echo dist/app.js" }],
					outputFrom: "missing",
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toContain("workflow.steps[0].outputFrom must reference a check id on the same step");
	});

	it("rejects outputFrom when it references a non-deterministic check", () => {
		const result = validateWorkflow({
			name: "agent-output-from",
			steps: [
				{
					id: "build",
					prompt: "build",
					checks: [{ type: "agent", id: "review", prompt: "looks good?" }],
					outputFrom: "review",
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toContain("workflow.steps[0].outputFrom must reference a deterministic check");
	});

	it("rejects invalid workflow names", () => {
		const result = validateWorkflow({ name: "Bad Name", steps: [{ id: "one", prompt: "a" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain("workflow.name must match /^[a-z0-9-]+$/");
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

	it("accepts retry-based model and thinking-level settings", () => {
		const workflow = {
			name: "retry-model-selection",
			steps: [
				{
					id: "implement",
					prompt: "a",
					model: "cheap/model:minimal",
					retryModelSelections: [
						{ retry: 1, model: "strong/model", thinkingLevel: "high" },
						{ retry: 3, model: "strongest/model:xhigh" },
						{ retry: 4, thinkingLevel: "xhigh" },
					],
				},
			],
		};

		expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
	});

	it("rejects malformed retry-based model and thinking-level settings", () => {
		const result = validateWorkflow({
			name: "bad-retry-model-selection",
			steps: [
				{
					id: "implement",
					prompt: "a",
					retryModelSelections: [
						"not-object",
						{ retry: -1, model: "strong/model" },
						{ retry: 1.5, thinkingLevel: "deep" },
						{ retry: 2, model: "" },
						{ retry: 3 },
						{ retry: 2, model: "other/model" },
					],
				},
				{ id: "other", prompt: "b", retryModelSelections: "nope" },
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.steps[0].retryModelSelections[0] must be an object");
			expect(result.errors).toContain("workflow.steps[0].retryModelSelections[1].retry must be a non-negative integer");
			expect(result.errors).toContain("workflow.steps[0].retryModelSelections[2].retry must be a non-negative integer");
			expect(result.errors).toContain("workflow.steps[0].retryModelSelections[3].model must be a non-empty string when provided");
			expect(result.errors).toContain(
				'workflow.steps[0].retryModelSelections[2].thinkingLevel must be one of "off", "minimal", "low", "medium", "high", or "xhigh" when provided',
			);
			expect(result.errors).toContain(
				"workflow.steps[0].retryModelSelections[4] must provide model or thinkingLevel",
			);
			expect(result.errors).toContain("workflow.steps[0].retryModelSelections duplicate retry value 2");
			expect(result.errors).toContain("workflow.steps[1].retryModelSelections must be an array when provided");
		}
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

	it("rejects malformed defaults", () => {
		expect(validateWorkflow({ name: "bad-defaults", defaults: "nope", steps: [{ id: "one", prompt: "a" }] })).toEqual({
			ok: false,
			errors: ["workflow.defaults must be an object when provided"],
		});

		const result = validateWorkflow({
			name: "bad-default-fields",
			defaults: { maxLoops: -1, onFail: { goto: "", maxLoops: 1.2, onExhausted: "later", feedback: "yes" } },
			steps: [{ id: "one", prompt: "a" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
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
					retrymodelselections: [{ retry: 1, model: "strong/model" }],
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
			expect(result.errors).toContain("workflow.steps[0].retrymodelselections is not recognized");
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
				{ id: "", title: 1, prompt: 3, skipIf: "no", checks: "nope", onFail: [] },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("workflow.steps[0] must be an object");
			expect(result.errors).toContain("workflow.steps[1].id must be a non-empty string");
			expect(result.errors).toContain("workflow.steps[1].title must be a string when provided");
			expect(result.errors).toContain("workflow.steps[1].prompt must be a string or function");
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
						{ type: "agent", id: "", name: 1, prompt: 2, onFail: { goto: "missing" } },
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
			expect(result.errors).toContain('workflow.steps[0].checks[2].type must be "deterministic" or "agent"');
		}
	});

	describe("forEach", () => {
		it("accepts function and command item sources", () => {
			const workflow = {
				name: "fanout",
				steps: [
					{ id: "a", prompt: "work {item}", forEach: { items: () => ["x"] } },
					{
						id: "b",
						prompt: "work {item}",
						forEach: { items: { command: "git diff --name-only", parse: "lines" }, maxItems: 5, onItemExhausted: "continue" },
					},
				],
			};
			expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
		});

		it("rejects malformed forEach schema and unknown keys", () => {
			const result = validateWorkflow({
				name: "bad-foreach",
				steps: [
					{
						id: "a",
						prompt: "work",
						forEach: { items: { command: 5, parse: "xml" }, concurrency: 0, maxItems: -1, onItemExhausted: "sometimes", extra: true },
					},
				],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContain("workflow.steps[0].forEach.extra is not recognized");
				expect(result.errors).toContain("workflow.steps[0].forEach.items.command must be a string or function");
				expect(result.errors).toContain('workflow.steps[0].forEach.items.parse must be "lines" or "json" when provided');
				expect(result.errors).toContain("workflow.steps[0].forEach.concurrency must be a positive integer when provided");
				expect(result.errors).toContain("workflow.steps[0].forEach.maxItems must be a positive integer when provided");
				expect(result.errors).toContain('workflow.steps[0].forEach.onItemExhausted must be "stop" or "continue" when provided');
			}
		});

		it("rejects a items source that is neither a function nor a command object", () => {
			const result = validateWorkflow({
				name: "bad-items",
				steps: [{ id: "a", prompt: "work", forEach: { items: "x" } }],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errors).toContain("workflow.steps[0].forEach.items must be a function or command object");
		});

		it("rejects a check onFail.goto that leaves the forEach step", () => {
			const result = validateWorkflow({
				name: "goto-out",
				steps: [
					{
						id: "fanout",
						prompt: "work {item}",
						forEach: { items: () => ["x"] },
						checks: [{ type: "deterministic", command: "test", onFail: { goto: "other" } }],
					},
					{ id: "other", prompt: "b" },
				],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContain("workflow.steps[0].checks[0].onFail.goto must target the containing forEach step");
			}
		});

		it("rejects step- and workflow-level onFail.goto defaults that leave a forEach step", () => {
			const result = validateWorkflow({
				name: "goto-out-defaults",
				defaults: { onFail: { goto: "other" } },
				steps: [
					{
						id: "fanout",
						prompt: "work {item}",
						forEach: { items: () => ["x"] },
						onFail: { goto: "other" },
						checks: [{ type: "deterministic", command: "test" }],
					},
					{ id: "other", prompt: "b" },
				],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContain("workflow.steps[0].onFail.goto must target the containing forEach step");
				expect(result.errors).toContain("workflow.defaults.onFail.goto must target the containing forEach step");
			}
		});

		it("allows a self-targeting check onFail.goto inside a forEach step", () => {
			const workflow = {
				name: "goto-self",
				steps: [
					{
						id: "fanout",
						prompt: "work {item}",
						forEach: { items: () => ["x"] },
						checks: [{ type: "deterministic", command: "test", onFail: { goto: "fanout", maxLoops: 1 } }],
					},
				],
			};
			expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
		});

		it("accepts concurrency greater than one without inspecting delegation", () => {
			const workflow = {
				name: "parallel-request",
				steps: [{ id: "items", prompt: "Use subagents for {item}", forEach: { items: () => ["a"], concurrency: 4 } }],
			};
			expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
		});

		it("rejects outputFrom on a forEach step", () => {
			const result = validateWorkflow({
				name: "foreach-outputfrom",
				steps: [
					{
						id: "a",
						prompt: "work {item}",
						forEach: { items: () => ["x"] },
						outputFrom: "cap",
						checks: [{ type: "deterministic", id: "cap", command: "test" }],
					},
				],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors.join("\n")).toContain("workflow.steps[0].outputFrom is not supported on a forEach step");
			}
		});
	});
});
