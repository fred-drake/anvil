import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverWorkflows, type DiscoveredWorkflow } from "./discovery.ts";
import { type AnvilCheckpoint, type EngineHost, runWorkflow, type StepModelSelection } from "./engine.ts";
import { AnvilAbortError } from "./errors.ts";
import { VerdictBus } from "./gates.ts";
import { buildSubagentResultMessage, workflowSubagentBackends } from "./prompts.ts";
import { cmuxUnavailableMessage, isCmuxAvailable } from "./subagent/cmux.ts";
import { herdrUnavailableMessage, isHerdrAvailable } from "./subagent/herdr.ts";
import { runCmuxSubagent, runHerdrSubagent } from "./subagent/runner.ts";
import type { WorkflowDefinition, WorkflowSubagentBackend } from "./types.ts";
import { renderSummaryMarkdown } from "./ui.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const builderSkillPath = join(baseDir, "..", "skills", "anvil-workflow-builder", "SKILL.md");

type ActiveRun = {
	controller: AbortController;
	runId: string;
};

type ResumableRun = {
	runId: string;
	workflowName: string;
	input: string;
	finalState: "failed" | "aborted";
	timestamp: string;
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

type AutocompleteSuggestions = {
	items: AutocompleteItem[];
	prefix: string;
};

type AutocompleteProvider = {
	triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
};

type TurnWaiter = {
	started: boolean;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
};

const verdictBus = new VerdictBus();
const turnWaiters = new Set<TurnWaiter>();

const anvilVerdictTool = defineTool({
	name: "anvil_verdict",
	label: "Anvil Verdict",
	description: "Report the pass/fail verdict for an active anvil agent check.",
	parameters: Type.Object({
		check_id: Type.String({ description: "The exact check_id provided by Anvil." }),
		pass: Type.Boolean({ description: "Whether the check passed." }),
		reason: Type.String({ description: "Concise reason for the verdict." }),
	}),

	async execute(_toolCallId, params) {
		const matched = verdictBus.reportVerdict(params.check_id, params.pass, params.reason);
		return {
			content: [
				{
					type: "text" as const,
					text: matched
						? `Anvil verdict recorded for ${params.check_id}.`
						: `No active Anvil check is waiting for ${params.check_id}; the verdict was ignored.`,
				},
			],
			details: { matched, check_id: params.check_id, pass: params.pass, reason: params.reason },
		};
	},
});

/* c8 ignore start -- Pi extension registration and command/UI wiring are exercised through integration-style tests; pure internals remain covered directly. */
/* v8 ignore start -- Pi extension registration and command/UI wiring are exercised through integration-style tests; pure internals remain covered directly. */
export default function piAnvil(pi: ExtensionAPI) {
	let activeRun: ActiveRun | undefined;

	pi.registerTool(anvilVerdictTool);

	pi.registerMessageRenderer("anvil-summary", () => undefined);

	pi.on("resources_discover", () => ({ skillPaths: [builderSkillPath] }));

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => createAnvilAutocompleteProvider(current, ctx.cwd));
	});

	pi.on("agent_start", () => {
		for (const waiter of turnWaiters) waiter.started = true;
	});

	pi.on("agent_end", () => {
		for (const waiter of [...turnWaiters]) resolveTurnWaiter(waiter);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeRun?.controller.abort();
		activeRun = undefined;
		verdictBus.clear();
		ctx.ui.setStatus("anvil", undefined);
		ctx.ui.setWidget("anvil-steps", undefined);
	});

	pi.registerCommand("anvil", {
		description: "Run and manage declarative Anvil workflows.",
		getArgumentCompletions: async (argumentPrefix) => getAnvilCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { subcommand, rest } = parseAnvilArgs(args);
			try {
				switch (subcommand) {
					case "list":
						await handleList(pi, ctx);
						return;
					case "validate":
						await handleValidate(pi, ctx, rest);
						return;
					case "abort":
						if (!activeRun) {
							ctx.ui.notify("No Anvil workflow is running.", "info");
							return;
						}
						activeRun.controller.abort();
						if (!ctx.isIdle()) ctx.abort();
						ctx.ui.notify(`Aborting Anvil run ${activeRun.runId}.`, "warning");
						return;
					case "run":
						await handleRun(pi, ctx, rest, () => activeRun, (run) => {
							activeRun = run;
						});
						return;
					case "resume":
						await handleResume(pi, ctx, rest, () => activeRun, (run) => {
							activeRun = run;
						});
						return;
					default:
						ctx.ui.notify("Usage: /anvil <run|list|validate|abort|resume> ...", "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	async function handleRun(
		piApi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		rest: string,
		getActiveRun: () => ActiveRun | undefined,
		setActiveRun: (run: ActiveRun | undefined) => void,
	): Promise<void> {
		if (getActiveRun()) {
			ctx.ui.notify("An Anvil workflow is already running in this session.", "error");
			return;
		}

		const { name, input } = parseRunArgs(rest);
		if (!name) {
			ctx.ui.notify("Usage: /anvil run <workflow-name> <task input>", "warning");
			return;
		}

		const controller = new AbortController();
		const runId = newRunId();
		setActiveRun({ controller, runId });
		let launched = false;
		try {
			const workflow = await findWorkflow(ctx.cwd, name);
			if (!workflow) {
				ctx.ui.notify(`Workflow "${name}" was not found.`, "error");
				return;
			}
			if (workflow.errors?.length || !workflow.workflow) {
				postCommandMessage(piApi, "anvil-validate", formatWorkflowErrors(workflow));
				return;
			}

			const unavailableBackend = workflowSubagentBackends(workflow.workflow).find((backend) => !isSubagentBackendAvailable(backend));
			if (unavailableBackend) {
				ctx.ui.notify(
					`Workflow "${workflow.workflow.name}" declares ${unavailableBackend} subagent delegation. ${subagentUnavailableMessage(unavailableBackend)}`,
					"error",
				);
				return;
			}

			if (!ctx.isIdle()) await ctx.waitForIdle();
			if (controller.signal.aborted) return;

			const host = createEngineHost(piApi, ctx, controller);
			launched = true;
			ctx.ui.notify(`Started Anvil workflow "${workflow.workflow.name}" (${runId}).`, "info");

			void runWorkflow({
				workflow: workflow.workflow,
				input,
				cwd: ctx.cwd,
				host,
				runId,
				signal: controller.signal,
			})
				.catch((error) => {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				})
				.finally(() => {
					if (getActiveRun()?.runId === runId) setActiveRun(undefined);
				});
		} finally {
			if (!launched && getActiveRun()?.runId === runId) setActiveRun(undefined);
		}
	}

	async function handleResume(
		piApi: ExtensionAPI,
		ctx: ExtensionCommandContext,
		rest: string,
		getActiveRun: () => ActiveRun | undefined,
		setActiveRun: (run: ActiveRun | undefined) => void,
	): Promise<void> {
		if (getActiveRun()) {
			ctx.ui.notify("An Anvil workflow is already running in this session.", "error");
			return;
		}

		const previousRun = findLatestResumableRun(getSessionEntries(ctx));
		if (!previousRun) {
			ctx.ui.notify("No failed or aborted Anvil run was found to resume in this session.", "warning");
			return;
		}

		const parsed = parseResumeArgs(rest);
		if (parsed.error || parsed.stepNumber === undefined) {
			const workflow = await findWorkflow(ctx.cwd, previousRun.workflowName);
			if (!workflow) {
				ctx.ui.notify(`Workflow "${previousRun.workflowName}" was not found.`, "error");
				return;
			}
			if (workflow.errors?.length || !workflow.workflow) {
				postCommandMessage(piApi, "anvil-validate", formatWorkflowErrors(workflow));
				return;
			}
			if (parsed.error) ctx.ui.notify(parsed.error, "error");
			postCommandMessage(piApi, "anvil-resume", formatResumeStepMap(previousRun, workflow.workflow));
			return;
		}

		const controller = new AbortController();
		const runId = newRunId();
		setActiveRun({ controller, runId });
		let launched = false;
		try {
			const workflow = await findWorkflow(ctx.cwd, previousRun.workflowName);
			if (!workflow) {
				ctx.ui.notify(`Workflow "${previousRun.workflowName}" was not found.`, "error");
				return;
			}
			if (workflow.errors?.length || !workflow.workflow) {
				postCommandMessage(piApi, "anvil-validate", formatWorkflowErrors(workflow));
				return;
			}
			if (parsed.stepNumber < 1 || parsed.stepNumber > workflow.workflow.steps.length) {
				ctx.ui.notify(`Resume step ${parsed.stepNumber} is out of range for workflow "${workflow.workflow.name}".`, "error");
				postCommandMessage(piApi, "anvil-resume", formatResumeStepMap(previousRun, workflow.workflow));
				return;
			}

			const unavailableBackend = workflowSubagentBackends(workflow.workflow).find((backend) => !isSubagentBackendAvailable(backend));
			if (unavailableBackend) {
				ctx.ui.notify(
					`Workflow "${workflow.workflow.name}" declares ${unavailableBackend} subagent delegation. ${subagentUnavailableMessage(unavailableBackend)}`,
					"error",
				);
				return;
			}

			if (!ctx.isIdle()) await ctx.waitForIdle();
			if (controller.signal.aborted) return;

			const host = createEngineHost(piApi, ctx, controller);
			launched = true;
			ctx.ui.notify(`Resumed Anvil workflow "${workflow.workflow.name}" from step ${parsed.stepNumber} (${runId}).`, "info");

			void runWorkflow({
				workflow: workflow.workflow,
				input: previousRun.input,
				cwd: ctx.cwd,
				host,
				runId,
				resume: { stepNumber: parsed.stepNumber, retryCount: parsed.retryCount },
				signal: controller.signal,
			})
				.catch((error) => {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				})
				.finally(() => {
					if (getActiveRun()?.runId === runId) setActiveRun(undefined);
				});
		} finally {
			if (!launched && getActiveRun()?.runId === runId) setActiveRun(undefined);
		}
	}
}
/* v8 ignore stop */
/* c8 ignore stop */

function createEngineHost(pi: ExtensionAPI, ctx: ExtensionCommandContext, controller: AbortController): EngineHost {
	let pendingTurn: Promise<void> | undefined;
	const defaultModel = ctx.model;
	const defaultThinkingLevel = pi.getThinkingLevel();

	async function applyModelAndThinking(
		model: Model<Api> | undefined,
		thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
	): Promise<void> {
		if (model) {
			const changed = await pi.setModel(model);
			if (!changed) throw new Error(`Unable to switch to model "${model.provider}/${model.id}"; no API key is available.`);
		}
		pi.setThinkingLevel(thinkingLevel);
	}

	return {
		async applyStepModelSelection(selection) {
			if (!selection) {
				await applyModelAndThinking(defaultModel, defaultThinkingLevel);
				return;
			}

			const model = selection.model ? resolveModelReference(selection.model, ctx.modelRegistry.getAll()) : defaultModel;
			await applyModelAndThinking(
				model,
				(selection.thinkingLevel ?? defaultThinkingLevel) as ReturnType<ExtensionAPI["getThinkingLevel"]>,
			);
		},
		async runSubagent(request, signal) {
			const launch = {
				name: `Anvil: ${request.stepTitle}`,
				task: request.task,
				cwd: request.cwd,
				runId: request.runId,
				stepId: request.stepId,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				timeoutMs: request.timeoutMs,
			};
			const result =
				request.backend === "herdr" ? await runHerdrSubagent(launch, signal) : await runCmuxSubagent(launch, signal);
			// Inject the outcome into the main session's context (no extra turn)
			// so agent checks and later steps know what the subagent did.
			pi.sendMessage(
				{
					customType: "anvil-subagent-result",
					content: buildSubagentResultMessage({
						workflowName: request.workflowName,
						stepTitle: request.stepTitle,
						stepIndex: request.stepIndex,
						stepCount: request.stepCount,
						backend: request.backend,
						summary: result.summary,
						sessionFile: result.sessionFile,
					}),
					display: true,
					details: { ...result, stepId: request.stepId, runId: request.runId },
				},
				{ triggerTurn: false },
			);
			return result;
		},
		sendInstruction(instruction) {
			pendingTurn = waitForTurnCompletion(ctx, controller.signal);
			pi.sendUserMessage(instruction);
		},
		async waitForTurnComplete(signal) {
			const wait = pendingTurn ?? waitForTurnCompletion(ctx, signal);
			pendingTurn = undefined;
			await wait;
		},
		exec(command, args, options) {
			return pi.exec(command, args, {
				cwd: options?.cwd,
				timeout: options?.timeout,
				signal: options?.signal,
			});
		},
		awaitVerdict(checkId, timeoutMs, signal) {
			return verdictBus.awaitVerdict(checkId, timeoutMs, signal);
		},
		checkpoint(entry) {
			pi.appendEntry("anvil-run", entry);
		},
		notify(message, type) {
			ctx.ui.notify(message, type);
		},
		setStatus(text) {
			ctx.ui.setStatus("anvil", text);
		},
		setWidget(lines) {
			ctx.ui.setWidget("anvil-steps", lines);
		},
		postSummary(summary) {
			pi.sendMessage(
				{
					customType: "anvil-summary",
					content: renderSummaryMarkdown(summary),
					display: true,
					details: summary,
				},
				{ triggerTurn: false },
			);
		},
	};
}

function isSubagentBackendAvailable(backend: WorkflowSubagentBackend): boolean {
	return backend === "herdr" ? isHerdrAvailable() : isCmuxAvailable();
}

function subagentUnavailableMessage(backend: WorkflowSubagentBackend): string {
	return backend === "herdr" ? herdrUnavailableMessage() : cmuxUnavailableMessage();
}

async function handleList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const workflows = await discoverWorkflows({ cwd: ctx.cwd, useCache: false });
	if (workflows.length === 0) {
		ctx.ui.notify("No Anvil workflows found in ~/.pi/agent/anvil/workflows or .pi/anvil/workflows.", "info");
		return;
	}
	postCommandMessage(pi, "anvil-list", formatWorkflowList(workflows));
}

async function handleValidate(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const name = rest.trim();
	if (!name) {
		ctx.ui.notify("Usage: /anvil validate <workflow-name>", "warning");
		return;
	}
	const workflow = await findWorkflow(ctx.cwd, name);
	if (!workflow) {
		ctx.ui.notify(`Workflow "${name}" was not found.`, "error");
		return;
	}
	postCommandMessage(
		pi,
		"anvil-validate",
		workflow.errors?.length ? formatWorkflowErrors(workflow) : `✅ Workflow \`${workflow.name}\` is valid.\n\n${workflow.file}`,
	);
}

async function findWorkflow(cwd: string, name: string): Promise<DiscoveredWorkflow | undefined> {
	const workflows = await discoverWorkflows({ cwd, useCache: false });
	return workflows.find((workflow) => workflow.name === name);
}

function postCommandMessage(pi: ExtensionAPI, customType: string, content: string): void {
	pi.sendMessage({ customType, content, display: true }, { triggerTurn: false });
}

function resolveModelReference(reference: string, models: Model<Api>[]): Model<Api> {
	const providerSeparator = reference.indexOf("/");
	if (providerSeparator > 0) {
		const provider = reference.slice(0, providerSeparator);
		const modelId = reference.slice(providerSeparator + 1);
		const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
		if (model) return model;
		throw new Error(`model "${reference}" was not found`);
	}

	const exactMatches = models.filter((model) => model.id === reference);
	if (exactMatches.length === 1) return exactMatches[0]!;
	if (exactMatches.length > 1) {
		throw new Error(`model "${reference}" is ambiguous; use provider/model syntax`);
	}

	throw new Error(`model "${reference}" was not found`);
}

export function createAnvilAutocompleteProvider(current: AutocompleteProvider, cwd: string): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const beforeCursor = currentLine.slice(0, cursorCol);
			const anvilArgs = extractAnvilArgumentText(beforeCursor);
			if (anvilArgs === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const items = await getAnvilCompletions(anvilArgs, cwd);
			if (items === null) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: anvilArgs };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function extractAnvilArgumentText(textBeforeCursor: string): string | undefined {
	return /^\/anvil(?::\d+)?\s+([\s\S]*)$/.exec(textBeforeCursor)?.[1];
}

export async function getAnvilCompletions(argumentPrefix: string, cwd: string) {
	const subcommands = ["run", "list", "validate", "abort", "resume"];
	const trimmedStart = argumentPrefix.trimStart();
	const parts = trimmedStart.split(/\s+/);
	if (parts.length <= 1 && !trimmedStart.endsWith(" ")) {
		return subcommands
			.filter((cmd) => cmd.startsWith(parts[0] ?? ""))
			.map((label) => ({ value: label, label }));
	}

	const subcommand = parts[0];
	if ((subcommand === "run" || subcommand === "validate") && parts.length <= 2) {
		const prefix = parts[1] ?? "";
		const workflows = await discoverWorkflows({ cwd });
		return workflows
			.filter((workflow) => workflow.name.startsWith(prefix))
			.map((workflow) => ({
				value: `${subcommand} ${workflow.name}`,
				label: workflow.name,
				description: workflow.errors?.length ? "invalid" : workflow.source,
			}));
	}
	return null;
}

function parseAnvilArgs(args: string): { subcommand: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { subcommand: "list", rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return { subcommand: match?.[1] ?? "list", rest: match?.[2] ?? "" };
}

function parseRunArgs(rest: string): { name: string; input: string } {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest.trim());
	return { name: match?.[1] ?? "", input: match?.[2] ?? "" };
}

function parseResumeArgs(rest: string): { stepNumber?: number; retryCount?: number; error?: string } {
	const parts = rest.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return {};
	if (parts.length > 2) return { error: "Usage: /anvil resume <step> [retry-number]" };
	if (!/^\d+$/.test(parts[0]!)) return { error: "Resume step must be a positive integer." };
	const stepNumber = Number(parts[0]);
	if (stepNumber < 1) return { error: "Resume step must be a positive integer." };
	if (parts[1] === undefined) return { stepNumber };
	if (!/^\d+$/.test(parts[1]!)) return { error: "Resume retry-number must be a non-negative integer." };
	return { stepNumber, retryCount: Number(parts[1]) };
}

function getSessionEntries(ctx: ExtensionCommandContext): unknown[] {
	const sessionManager = (ctx as ExtensionCommandContext & { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
	const entries = sessionManager?.getEntries?.();
	return Array.isArray(entries) ? entries : [];
}

function findLatestResumableRun(entries: unknown[]): ResumableRun | undefined {
	let latest: ResumableRun | undefined;
	for (const entry of entries) {
		const checkpoint = toAnvilCheckpoint(entry);
		if (!checkpoint || checkpoint.phase !== "run_end") continue;
		if (checkpoint.finalState !== "aborted" && checkpoint.finalState !== "failed") continue;
		if (!checkpoint.runId || !checkpoint.workflowName || checkpoint.input === undefined) continue;
		latest = {
			runId: checkpoint.runId,
			workflowName: checkpoint.workflowName,
			input: checkpoint.input,
			finalState: checkpoint.finalState,
			timestamp: checkpoint.timestamp ?? "",
		};
	}
	return latest;
}

function toAnvilCheckpoint(entry: unknown): Partial<AnvilCheckpoint> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.customType !== "anvil-run") return undefined;
	const data = record.data ?? record.details ?? record;
	return data && typeof data === "object" ? (data as Partial<AnvilCheckpoint>) : undefined;
}

function formatResumeStepMap(run: ResumableRun, workflow: WorkflowDefinition): string {
	const lines = [
		`# Resume Anvil workflow \`${workflow.name}\``,
		"",
		`Latest resumable run: \`${run.runId}\` (${run.finalState})`,
		`Task input: ${run.input || "_(empty)_"}`,
		"",
		"Choose the one-based step number to resume from:",
		"",
	];
	workflow.steps.forEach((step, index) => {
		const title = step.title ?? step.id;
		lines.push(`${index + 1}. ${title} (\`${step.id}\`)`);
	});
	lines.push("", "Run `/anvil resume <step> [retry-number]`.");
	lines.push("Omit `retry-number` for no retries, or pass the current retry count to seed `{loop}` for the resumed step.");
	return lines.join("\n");
}

function formatWorkflowList(workflows: DiscoveredWorkflow[]): string {
	const lines = ["# Anvil workflows", ""];
	for (const workflow of workflows) {
		const icon = workflow.errors?.length ? "❌" : "✅";
		const description = workflow.workflow?.description ? ` — ${workflow.workflow.description}` : "";
		lines.push(`${icon} \`${workflow.name}\` (${workflow.source})${description}`);
		if (workflow.errors?.length) {
			for (const error of workflow.errors) lines.push(`   - ${error}`);
		}
	}
	return lines.join("\n");
}

function formatWorkflowErrors(workflow: DiscoveredWorkflow): string {
	return [
		`❌ Workflow \`${workflow.name}\` is invalid.`,
		"",
		workflow.file,
		"",
		...(workflow.errors ?? ["unknown error"]).map((error) => `- ${error}`),
	].join("\n");
}

function waitForTurnCompletion(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void> {
	return waitForOneTurnOrIdle(ctx, signal).then(async () => {
		await ctx.waitForIdle();
		while (ctx.hasPendingMessages()) {
			await waitForOneTurnOrIdle(ctx, signal);
			await ctx.waitForIdle();
		}
	});
}

function waitForOneTurnOrIdle(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new AnvilAbortError());
	return new Promise<void>((resolve, reject) => {
		const waiter: TurnWaiter = {
			started: false,
			resolve: () => resolve(),
			reject,
			timer: setTimeout(() => {
				if (!waiter.started && ctx.isIdle()) resolveTurnWaiter(waiter);
			}, 2_000),
			signal,
		};
		waiter.onAbort = () => rejectTurnWaiter(waiter, new AnvilAbortError());
		if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
		turnWaiters.add(waiter);
	});
}

function resolveTurnWaiter(waiter: TurnWaiter): void {
	cleanupTurnWaiter(waiter);
	waiter.resolve();
}

function rejectTurnWaiter(waiter: TurnWaiter, error: Error): void {
	cleanupTurnWaiter(waiter);
	waiter.reject(error);
}

function cleanupTurnWaiter(waiter: TurnWaiter): void {
	clearTimeout(waiter.timer);
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	turnWaiters.delete(waiter);
}

function newRunId(): string {
	return `anvil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const __testing__ = { resolveModelReference, parseAnvilArgs, parseRunArgs };
