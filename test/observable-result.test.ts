import { describe, expect, it, vi } from "vitest";
import {
	captureObservableStepResult,
	MAX_OBSERVABLE_RESULT_BYTES,
	MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS,
} from "../src/observable-result.ts";

describe("captureObservableStepResult", () => {
	it("uses one fixed missing state for absent, empty, and whitespace-only output", () => {
		for (const output of [undefined, "", " \n\t "]) {
			expect(captureObservableStepResult(output)).toEqual({ state: "missing" });
		}
	});

	it("redacts common secret shapes and normalizes unsafe controls", () => {
		const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
		const result = captureObservableStepResult(`ok\u0000\r\nsecret=${secret}`);
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		expect(result.text).toContain("[REDACTED SECRET]");
		expect(result.text).not.toContain(secret);
		expect(result.text).not.toContain("\u0000");
		expect(result.text).not.toContain("\r");
	});

	it("redacts Slack, GitLab, fine-grained GitHub, JWT, cookie, and Basic credentials", () => {
		const secrets = [
			["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
			["xapp", "1", "A0123456789", "1234567890123", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"),
			"glpat-abcdefghijklmnopqrst",
			"github_pat_11AA0abcdefghijklmnopqrstuvwxyz_0123456789",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
			"session=super-secret-cookie-value; theme=dark",
			"YTpi",
		];
		const result = captureObservableStepResult([
			secrets[0],
			secrets[1],
			secrets[2],
			secrets[3],
			secrets[4],
			`Cookie: ${secrets[5]}`,
			`cookie=${secrets[5]}`,
			`Authorization: Basic ${secrets[6]}`,
		].join("\n"));
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		for (const secret of secrets) expect(result.text).not.toContain(secret);
		expect(result.text.match(/\[REDACTED SECRET\]/g)?.length).toBe(8);
	});

	it("does not expose credentials whose labels are split at the capture boundary", () => {
		const cases = [
			{ line: "api_key=boundary-api-secret", splitAt: 3, secret: "boundary-api-secret" },
			{ line: "cookie=boundary-cookie-secret", splitAt: 2, secret: "boundary-cookie-secret" },
			{ line: "Authorization: Basic YTpi", splitAt: 17, secret: "YTpi" },
		];
		for (const { line, splitAt, secret } of cases) {
			const framing = "\n-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----\nSAFE_BOUNDARY_TAIL";
			const bodyLength = MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS + splitAt - line.length - framing.length;
			const output = `${line}\n-----BEGIN PRIVATE KEY-----\n${"A".repeat(bodyLength)}\n-----END PRIVATE KEY-----\nSAFE_BOUNDARY_TAIL`;
			expect(output.length - MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS).toBe(splitAt);
			const result = captureObservableStepResult(output);
			if (result.state !== "present") {
				expect(result).toEqual({ state: "missing" });
				continue;
			}
			expect(result.text).toContain("SAFE_BOUNDARY_TAIL");
			expect(result.text).not.toContain(secret);
		}
	});

	it("fails closed on ambiguous and unmatched private-key fragments", () => {
		const keyBodySentinel = "PRIVATE_KEY_BODY_MUST_NOT_REACH_REVIEWER";
		const begin = "-----BEGIN PRIVATE KEY-----";
		const end = "-----END PRIVATE KEY-----";
		const unmatchedBegin = captureObservableStepResult(`${begin}\n${keyBodySentinel}`);
		expect(unmatchedBegin.state).toBe("missing");

		const visibleTails = [
			`${keyBodySentinel}\n${end}`,
			`${keyBodySentinel}\n${begin}\nFORGED-DECOY\n${end}`,
		];
		for (const visibleTail of visibleTails) {
			const suffix = `${"A".repeat(MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS - visibleTail.length - 1)}\n${visibleTail}`;
			const output = `${begin}\n${suffix}`;
			const result = captureObservableStepResult(output);
			expect(result.state).toBe("missing");
			if (result.state !== "present") continue;
			expect(result.text).not.toContain(keyBodySentinel);
		}
	});

	it("retains a complete line that starts exactly at the bounded scan suffix", () => {
		const tail = `${"🙂".repeat(5_000)}EXACT_BOUNDARY_TAIL`;
		const padding = "x".repeat(MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS - tail.length);
		const result = captureObservableStepResult(`discarded\n${padding}${tail}`);
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		expect(result.text).toContain("EXACT_BOUNDARY_TAIL");
	});

	it("redacts AWS secret assignments and generic private-key blocks", () => {
		const awsSecret = "aws-secret-value-123456789";
		const keyBody = "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=";
		const result = captureObservableStepResult([
			`AWS_SECRET_ACCESS_KEY=${awsSecret}`,
			"-----BEGIN PRIVATE KEY-----",
			keyBody,
			"-----END PRIVATE KEY-----",
		].join("\n"));
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		expect(result.text).not.toContain(awsSecret);
		expect(result.text).not.toContain(keyBody);
		expect(result.text.match(/\[REDACTED SECRET\]/g)?.length).toBe(2);
	});

	it("redacts NPM tokens and plain, quoted, and JSON database URLs", () => {
		const npmToken = "npm_super_secret_token_value_123456789";
		const databaseUrls = [
			"postgresql://admin:database-password@db.example.test/app",
			"mysql://quoted-user:quoted-password@db.example.test/app",
			"mongodb://json-user:json-password@db.example.test/app",
		];
		const result = captureObservableStepResult([
			`NPM_TOKEN=${npmToken}`,
			`DATABASE_URL=${databaseUrls[0]}`,
			`DATABASE_URL=\"${databaseUrls[1]}\"`,
			`{\"DATABASE_URL\": \"${databaseUrls[2]}\"}`,
		].join("\n"));
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		expect(result.text).not.toContain(npmToken);
		for (const databaseUrl of databaseUrls) expect(result.text).not.toContain(databaseUrl);
		for (const password of ["database-password", "quoted-password", "json-password"]) {
			expect(result.text).not.toContain(password);
		}
		expect(result.text.match(/\[REDACTED SECRET\]/g)?.length).toBe(4);
	});

	it("keeps a redaction-shrunk oversized result valid and bounded", () => {
		const result = captureObservableStepResult([
			"-----BEGIN PRIVATE KEY-----",
			"A".repeat(MAX_OBSERVABLE_RESULT_BYTES + 1),
			"-----END PRIVATE KEY-----",
		].join("\n"));
		expect(result.state).toBe("present");
		if (result.state !== "present") return;
		expect(result.text).toContain("[REDACTED SECRET]");
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_OBSERVABLE_RESULT_BYTES);
	});

	it("deterministically keeps a valid UTF-8 tail within the byte budget including its marker", () => {
		const output = `${"prefix🙂".repeat(2_000)}DETERMINISTIC_TAIL`;
		const first = captureObservableStepResult(output);
		const second = captureObservableStepResult(output);
		expect(first).toEqual(second);
		expect(first.state).toBe("present");
		if (first.state !== "present") return;
		expect(first.text).toMatch(/^\[Observable step result truncated;/);
		expect(first.text).toContain("DETERMINISTIC_TAIL");
		expect(first.text).not.toContain("�");
		expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(MAX_OBSERVABLE_RESULT_BYTES);
	});

	it("bounds sanitization and byte copies before processing very large output", () => {
		const replace = String.prototype.replace;
		const byteLength = Buffer.byteLength;
		const processedLengths: number[] = [];
		const copiedLengths: number[] = [];
		const replaceSpy = vi.spyOn(String.prototype, "replace").mockImplementation(function (
			this: string,
			pattern: string | RegExp,
			replacement: string | ((substring: string, ...args: unknown[]) => string),
		) {
			processedLengths.push(String(this).length);
			return replace.call(this, pattern, replacement as string);
		});
		const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
			copiedLengths.push(typeof value === "string" ? value.length : value.byteLength);
			return byteLength(value, encoding);
		});

		try {
			const output = `${"discarded-prefix".repeat(1_000_000)}\n${"🙂".repeat(5_000)}BOUNDED_TAIL`;
			const result = captureObservableStepResult(output);
			expect(result.state).toBe("present");
			if (result.state !== "present") return;
			expect(result.text).toContain("BOUNDED_TAIL");
			expect(Math.max(...processedLengths)).toBeLessThanOrEqual(MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS);
			expect(Math.max(...copiedLengths)).toBeLessThanOrEqual(MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS);
		} finally {
			replaceSpy.mockRestore();
			byteLengthSpy.mockRestore();
		}
	});
});
