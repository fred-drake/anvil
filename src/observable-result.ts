export const MAX_OBSERVABLE_RESULT_BYTES = 8 * 1024;
/** Maximum UTF-16 suffix inspected before sanitization, keeping capture work bounded. */
export const MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS = 64 * 1024;
export const MISSING_OBSERVABLE_RESULT = "No observable step output was captured.";
const TRUNCATION_MARKER = "[Observable step result truncated; showing deterministic UTF-8 tail]\n";
const REDACTION = "[REDACTED SECRET]";

export type ObservableStepResult =
	| { state: "missing" }
	| { state: "present"; text: string };

/**
 * Converts intentionally reported step output into bounded, prompt-only review data.
 * Redaction is conservative defense in depth, not a general secret detector.
 */
export function captureObservableStepResult(output: string | undefined): ObservableStepResult {
	if (output === undefined) return { state: "missing" };
	const { tail: boundedInput, clipped } = boundedCodeUnitTail(output);
	const inputBytes = Buffer.byteLength(boundedInput, "utf8");
	const normalized = sanitizeControls(boundedInput);
	// A marker in a clipped suffix is ambiguous because its true matching marker may
	// be outside the scan window. Unmatched markers are unsafe at any input size.
	if (hasAmbiguousPrivateKeyFragment(normalized, clipped)) return { state: "missing" };
	const sanitized = redactSecrets(normalized);
	if (sanitized.trim().length === 0) return { state: "missing" };
	if (!clipped && inputBytes <= MAX_OBSERVABLE_RESULT_BYTES && Buffer.byteLength(sanitized, "utf8") <= MAX_OBSERVABLE_RESULT_BYTES) {
		return { state: "present", text: sanitized };
	}

	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const tail = utf8Tail(sanitized, MAX_OBSERVABLE_RESULT_BYTES - markerBytes);
	return { state: "present", text: TRUNCATION_MARKER + tail };
}

function boundedCodeUnitTail(value: string): { tail: string; clipped: boolean } {
	if (value.length <= MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS) return { tail: value, clipped: false };
	let start = value.length - MAX_OBSERVABLE_RESULT_SCAN_CODE_UNITS;
	let startsAtLineBoundary = value[start - 1] === "\r" || value[start - 1] === "\n";
	const first = value.charCodeAt(start);
	if (first >= 0xdc00 && first <= 0xdfff) {
		start += 1;
		startsAtLineBoundary = false;
	}
	const boundedTail = value.slice(start);
	if (startsAtLineBoundary) return { tail: boundedTail, clipped: true };
	const lineBreak = boundedTail.search(/[\r\n]/u);
	if (lineBreak < 0) return { tail: "", clipped: true };
	const afterLineBreak = lineBreak + (boundedTail[lineBreak] === "\r" && boundedTail[lineBreak + 1] === "\n" ? 2 : 1);
	return { tail: boundedTail.slice(afterLineBreak), clipped: true };
}

function sanitizeControls(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ");
}

function hasAmbiguousPrivateKeyFragment(value: string, clipped: boolean): boolean {
	const marker = /-----((?:BEGIN)|(?:END))(?: [A-Z0-9]+)* PRIVATE KEY-----/giu;
	let openBlocks = 0;
	let markerCount = 0;
	for (const match of value.matchAll(marker)) {
		markerCount += 1;
		if (match[1]?.toUpperCase() === "BEGIN") {
			openBlocks += 1;
		} else if (openBlocks === 0) {
			return true;
		} else {
			openBlocks -= 1;
		}
	}
	return openBlocks !== 0 || (clipped && markerCount > 0);
}

function redactSecrets(value: string): string {
	return value
		.replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu, REDACTION)
		.replace(/\b(set-cookie|cookie)\s*[:=]\s*[^\n]*/giu, `$1=${REDACTION}`)
		.replace(/\b(AWS_SECRET_ACCESS_KEY|NPM_TOKEN)\s*[:=]\s*([^\s,;]+)/giu, `$1=${REDACTION}`)
		.replace(/\b(DATABASE_URL)\b(["']?\s*[:=]\s*)["']?[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^@\s/]+@[^\s,;"']+["']?/giu, `$1$2${REDACTION}`)
		.replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)/giu, `$1=${REDACTION}`)
		.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, REDACTION)
		.replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9_-]{10,}\b/giu, REDACTION)
		.replace(/\bgl(?:pat|ptt|rt|dt|cbt|imt|agent)-[A-Za-z0-9_-]{10,}\b/giu, REDACTION)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, REDACTION)
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, REDACTION)
		.replace(/\bAKIA[A-Z0-9]{16}\b/gu, REDACTION)
		.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu, REDACTION)
		.replace(/\bBasic\s+[A-Za-z0-9+/]{2,}={0,2}/giu, `Basic ${REDACTION}`)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu, `Bearer ${REDACTION}`);
}

function utf8Tail(value: string, maxBytes: number): string {
	const encoded = Buffer.from(value, "utf8");
	let start = Math.max(0, encoded.length - maxBytes);
	while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
	return encoded.subarray(start).toString("utf8");
}
