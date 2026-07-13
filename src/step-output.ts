export const MAX_STEP_OUTPUT_BYTES = 8 * 1024;

/** Keep the newest complete UTF-8 characters within the persisted step-output budget. */
export function truncateStepOutput(output: string): string {
	const encoded = Buffer.from(output, "utf8");
	if (encoded.byteLength <= MAX_STEP_OUTPUT_BYTES) return output;

	let start = encoded.byteLength - MAX_STEP_OUTPUT_BYTES;
	while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
	return encoded.subarray(start).toString("utf8");
}

export function isBoundedStepOutput(output: string): boolean {
	return Buffer.byteLength(output, "utf8") <= MAX_STEP_OUTPUT_BYTES;
}
