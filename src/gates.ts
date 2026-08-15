import type { EngineHost } from "./engine.ts";
import { abortError } from "./errors.ts";
import {
	buildAgentCheckInstruction,
	buildVerdictReprompt,
	renderCommandTemplatable,
} from "./prompts.ts";
import type {
	AgentCheck,
	Check,
	DeterministicCheck,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowStep,
} from "./types.ts";

export interface Verdict {
	checkId: string;
	pass: boolean;
	reason: string;
}

export interface GateResult {
	check: Check;
	checkId: string;
	name: string;
	pass: boolean;
	reason: string;
	/** Rendered command for deterministic evidence records. */
	command?: string;
	timeoutMs?: number;
	output?: string;
}

export const DEFAULT_DETERMINISTIC_TIMEOUT_MS = 300_000;
export const DEFAULT_AGENT_VERDICT_TIMEOUT_MS = 300_000;

export class VerdictBus {
	private waiters = new Map<
		string,
		{
			resolve: (verdict: Verdict | undefined) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
			onAbort?: () => void;
			signal?: AbortSignal;
		}
	>();

	awaitVerdict(checkId: string, timeoutMs: number, signal?: AbortSignal): Promise<Verdict | undefined> {
		if (signal?.aborted) return Promise.reject(abortError());

		const existing = this.waiters.get(checkId);
		if (existing) {
			clearTimeout(existing.timeout);
			existing.signal?.removeEventListener("abort", existing.onAbort ?? (() => undefined));
			existing.resolve(undefined);
			this.waiters.delete(checkId);
		}

		return new Promise<Verdict | undefined>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				this.waiters.delete(checkId);
			};
			const timeout = setTimeout(() => {
				cleanup();
				resolve(undefined);
			}, timeoutMs);
			const onAbort = signal
				? () => {
					cleanup();
					reject(abortError());
				}
				: undefined;
			if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
			this.waiters.set(checkId, { resolve, reject, timeout, onAbort, signal });
		});
	}

	reportVerdict(checkId: string, pass: boolean, reason: string): boolean {
		const waiter = this.waiters.get(checkId);
		if (!waiter) return false;
		clearTimeout(waiter.timeout);
		waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => undefined));
		this.waiters.delete(checkId);
		waiter.resolve({ checkId, pass, reason });
		return true;
	}

	clear(): void {
		for (const [checkId, waiter] of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => undefined));
			waiter.resolve(undefined);
			this.waiters.delete(checkId);
		}
	}
}

export async function executeDeterministicCheck(args: {
	host: EngineHost;
	check: DeterministicCheck;
	ctx: WorkflowContext;
	checkId: string;
	signal?: AbortSignal;
}): Promise<GateResult> {
	const command = await renderCommandTemplatable(args.check.command, args.ctx);
	const result = await args.host.exec("bash", ["-c", command], {
		cwd: args.check.cwd ?? args.ctx.cwd,
		timeout: args.check.timeoutMs ?? DEFAULT_DETERMINISTIC_TIMEOUT_MS,
		signal: args.signal,
	});
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	const pass = result.code === 0;
	const timeoutMs = args.check.timeoutMs ?? DEFAULT_DETERMINISTIC_TIMEOUT_MS;
	return {
		check: args.check,
		checkId: args.checkId,
		name: checkDisplayName(args.check, args.checkId),
		pass,
		reason: pass
			? "command exited 0"
			: result.killed
				? `command timed out after ${timeoutMs}ms${output ? `: ${tail(output, 2000)}` : ""}`
				: tail(output || `command exited ${result.code}`, 2000),
		command,
		timeoutMs,
		output,
	};
}

export async function executeAgentCheck(args: {
	host: EngineHost;
	workflow: WorkflowDefinition;
	step: WorkflowStep;
	check: AgentCheck;
	ctx: WorkflowContext;
	checkId: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<GateResult> {
	const firstWait = startVerdictWait(args);
	const instruction = await buildAgentCheckInstruction({
		workflow: args.workflow,
		step: args.step,
		check: args.check,
		ctx: args.ctx,
		checkId: args.checkId,
	});

	args.host.sendInstruction(instruction);
	let turnPromise = args.host.waitForTurnComplete(args.signal);
	const first = await raceVerdictOrTurn(firstWait.promise, turnPromise);
	if (first.kind === "verdict" && first.verdict) {
		await turnPromise;
		return verdictToGateResult(args.check, args.checkId, first.verdict);
	}
	if (first.kind === "turn") firstWait.cancel();

	const secondWait = startVerdictWait(args);

	args.host.sendInstruction(buildVerdictReprompt(args.checkId));
	turnPromise = args.host.waitForTurnComplete(args.signal);
	const second = await raceVerdictOrTurn(secondWait.promise, turnPromise);
	if (second.kind === "verdict" && second.verdict) {
		await turnPromise;
		return verdictToGateResult(args.check, args.checkId, second.verdict);
	}
	secondWait.cancel();

	return {
		check: args.check,
		checkId: args.checkId,
		name: checkDisplayName(args.check, args.checkId),
		pass: false,
		reason: "no verdict reported",
	};
}

function startVerdictWait(args: {
	host: EngineHost;
	checkId: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): { promise: Promise<Verdict | undefined>; cancel: () => void } {
	const controller = new AbortController();
	const signal = combineAbortSignals(args.signal, controller.signal);
	let canceled = false;
	const promise = args.host
		.awaitVerdict(args.checkId, args.timeoutMs ?? DEFAULT_AGENT_VERDICT_TIMEOUT_MS, signal)
		.catch((error) => {
			if (canceled) return undefined;
			throw error;
		});
	return {
		promise,
		cancel: () => {
			canceled = true;
			controller.abort();
			void promise.catch(() => undefined);
		},
	};
}

function combineAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
	if (!external) return internal;
	if (external.aborted) return external;
	return AbortSignal.any([external, internal]);
}

function verdictToGateResult(
	check: AgentCheck,
	checkId: string,
	verdict: Verdict,
	timeoutMs = check.timeoutMs ?? DEFAULT_AGENT_VERDICT_TIMEOUT_MS,
): GateResult {
	return {
		check,
		checkId,
		name: checkDisplayName(check, checkId),
		pass: verdict.pass,
		reason: verdict.reason,
		timeoutMs,
	};
}

async function raceVerdictOrTurn(
	verdictPromise: Promise<Verdict | undefined>,
	turnPromise: Promise<void>,
): Promise<{ kind: "verdict"; verdict: Verdict | undefined } | { kind: "turn" }> {
	return Promise.race([
		verdictPromise.then((verdict) => ({ kind: "verdict" as const, verdict })),
		turnPromise.then(async () => {
			// If the agent turn and verdict settle in the same tick, prefer the verdict.
			await Promise.resolve();
			return { kind: "turn" as const };
		}),
	]);
}

function checkDisplayName(check: Check, fallback: string): string {
	return check.name ?? check.id ?? fallback;
}

function tail(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : text.slice(-maxChars);
}
