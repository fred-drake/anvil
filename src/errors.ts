export class ReviewSubagentUnavailableError extends Error {
	constructor(message = "Independent review backend is unavailable.") {
		super(message);
		this.name = "ReviewSubagentUnavailableError";
	}
}

export class AnvilAbortError extends Error {
	constructor(message = "Anvil run aborted") {
		super(message);
		this.name = "AnvilAbortError";
	}
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AnvilAbortError();
}

export function abortError(): AnvilAbortError {
	return new AnvilAbortError();
}

export function isAnvilAbortError(error: unknown): error is AnvilAbortError {
	return error instanceof AnvilAbortError;
}

export function isReviewSubagentUnavailableError(error: unknown): error is ReviewSubagentUnavailableError {
	return error instanceof ReviewSubagentUnavailableError;
}
