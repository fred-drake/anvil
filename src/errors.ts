export class WorkflowInfrastructureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowInfrastructureError";
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

export function isWorkflowInfrastructureError(error: unknown): error is WorkflowInfrastructureError {
	return error instanceof WorkflowInfrastructureError;
}
