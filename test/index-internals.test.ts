import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { __testing__ } from "../src/index.ts";

const { parseAnvilArgs, parseRunArgs, resolveModelReference } = __testing__;

describe("index internals", () => {
	it("parses /anvil subcommands and preserves free-form run input", () => {
		expect(parseAnvilArgs("")).toEqual({ subcommand: "list", rest: "" });
		expect(parseAnvilArgs("run demo   build the thing")).toEqual({ subcommand: "run", rest: "demo   build the thing" });
		expect(parseRunArgs("demo   build the thing with spaces")).toEqual({
			name: "demo",
			input: "build the thing with spaces",
		});
	});

	it("resolves provider-qualified and unique bare model references", () => {
		const models = [
			{ provider: "openai", id: "gpt-5.5" },
			{ provider: "anthropic", id: "claude-sonnet-5" },
		] as any[];

		expect(resolveModelReference("openai/gpt-5.5", models)).toBe(models[0]);
		expect(resolveModelReference("claude-sonnet-5", models)).toBe(models[1]);
	});

	it("rejects ambiguous or missing model references with actionable errors", () => {
		const models = [
			{ provider: "openai", id: "shared" },
			{ provider: "anthropic", id: "shared" },
		] as any[];

		expect(() => resolveModelReference("shared", models)).toThrow(/ambiguous; use provider\/model syntax/);
		expect(() => resolveModelReference("openai/missing", models)).toThrow('model "openai/missing" was not found');
		expect(() => resolveModelReference("missing", models)).toThrow('model "missing" was not found');
	});

	it("does not exclude all of src/index.ts from coverage", () => {
		const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");

		expect(config).not.toMatch(/exclude:\s*\[[^\]]*["']src\/index\.ts["']/s);
	});
});
