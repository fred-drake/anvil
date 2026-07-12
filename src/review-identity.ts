import { createHash } from "node:crypto";

export const MAX_INDEPENDENT_REVIEW_IDENTITY_BYTES = 256;
export const MAX_INDEPENDENT_REVIEW_FILENAME_BYTES = 255;
const MAX_INDEPENDENT_REVIEW_PATH_COMPONENT_BYTES = 255;
const SAFE_INDEPENDENT_REVIEW_IDENTITY_RE = /^[\p{L}\p{N} ._:/-]+$/u;
const SAFE_INDEPENDENT_REVIEW_PATH_IDENTITY_RE = /^[\p{L}\p{N}._-]+$/u;
const SHA256_ALIAS_RE = /^sha256:([a-f0-9]{64})$/u;

/**
 * Keeps review prompt, launcher, and filesystem identity fields bounded and
 * free of control characters. Unsafe values use a deterministic alias.
 */
export function normalizeIndependentReviewIdentity(value: string): string {
	if (
		Buffer.byteLength(value, "utf8") <= MAX_INDEPENDENT_REVIEW_IDENTITY_BYTES &&
		SAFE_INDEPENDENT_REVIEW_IDENTITY_RE.test(value)
	) return value;
	return `sha256:${hashIdentity(value)}`;
}

/** Returns one safe, bounded filesystem component for a review identity. */
export function normalizeIndependentReviewPathIdentity(value: string): string {
	const alias = SHA256_ALIAS_RE.exec(value);
	if (alias) return `sha256-${alias[1]}`;
	if (
		value !== "." &&
		value !== ".." &&
		Buffer.byteLength(value, "utf8") <= MAX_INDEPENDENT_REVIEW_PATH_COMPONENT_BYTES &&
		SAFE_INDEPENDENT_REVIEW_PATH_IDENTITY_RE.test(value)
	) return value;
	return `sha256-${hashIdentity(value)}`;
}

/**
 * Builds one review filename while reserving room for sidecar extensions that
 * are appended later. Oversized complete basenames use the same deterministic
 * safe identity aliasing as review path components.
 */
export function buildIndependentReviewFilename(identity: string, suffix: string, reservedSuffix = ""): string {
	const filename = `${identity}${suffix}`;
	if (Buffer.byteLength(filename + reservedSuffix, "utf8") <= MAX_INDEPENDENT_REVIEW_FILENAME_BYTES) return filename;
	const aliased = `sha256-${hashIdentity(identity)}${suffix}`;
	if (Buffer.byteLength(aliased + reservedSuffix, "utf8") > MAX_INDEPENDENT_REVIEW_FILENAME_BYTES) {
		throw new Error("Independent review filename suffix exceeds the filesystem basename limit.");
	}
	return aliased;
}

function hashIdentity(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
