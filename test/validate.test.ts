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
});
