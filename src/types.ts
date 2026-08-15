export interface WorkflowContext {
	/** Free-form text from `/anvil run <name> ...`. */
	input: string;
	step: { id: string; index: number };
	/** "<checkId>-><stepId>" (or "<checkId>-><stepId>#<itemIndex>" in forEach) -> count. */
	loopCounts: Record<string, number>;
	cwd: string;
	/** Captured textual outputs of prior steps, keyed by step id. */
	outputs: Record<string, string>;
	/** Present only inside a forEach step; the string placeholders expand to "" elsewhere. */
	item?: string;
	itemIndex?: number;
	itemCount?: number;
}

export type Templatable = string | ((ctx: WorkflowContext) => string | Promise<string>);

export type ForEachItemSource =
	| ((ctx: WorkflowContext) => string[] | Promise<string[]>)
	| {
			/** Executed with the same shell-safe templating as deterministic checks. */
			command: Templatable;
			/** How to turn stdout into items. Defaults to "lines" (non-empty, trimmed). */
			parse?: "lines" | "json";
	  };

export interface WorkflowForEach {
	items: ForEachItemSource;
	/**
	 * Intended max concurrent item turns. Defaults to 1 (sequential). Parallel fan-out is not
	 * yet implemented: values > 1 are accepted but currently degrade to sequential with a warning.
	 */
	concurrency?: number;
	/** Safety cap on enumeration. Defaults to 100; exceeding it fails the step. */
	maxItems?: number;
	/**
	 * After an item exhausts its retries: fail the step naming the item ("stop", default), or
	 * record the failure and move on ("continue"), failing the step only if every item failed.
	 */
	onItemExhausted?: "stop" | "continue";
}

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type OnFailPolicy =
	| "stop"
	| "continue"
	| {
			goto: string;
			/** Defaults to workflow.defaults.maxLoops ?? 3. */
			maxLoops?: number;
			/** Defaults to "stop". */
			onExhausted?: "stop" | "continue";
			/** Defaults to true. */
			feedback?: boolean;
	  };

export interface DeterministicCheck {
	type: "deterministic";
	id?: string;
	name?: string;
	/** Executed with `bash -c`; exit code 0 means pass. */
	command: Templatable;
	cwd?: string;
	/** Defaults to 300_000. */
	timeoutMs?: number;
	onFail?: OnFailPolicy;
}

export interface AgentCheck {
	type: "agent";
	id?: string;
	name?: string;
	/** Evaluation criteria; anvil wraps this with verdict instructions. */
	prompt: Templatable;
	/** Defaults to 300_000. */
	timeoutMs?: number;
	onFail?: OnFailPolicy;
}

export type Check = DeterministicCheck | AgentCheck;

export interface WorkflowModelSelection {
	/** Model reference for the main harness turn. Supports pi's provider/id and optional :<thinking> shorthand. */
	model?: string;
	/** Main-harness thinking level. Omitted values keep the workflow-start or base step default. */
	thinkingLevel?: WorkflowThinkingLevel;
}

export interface WorkflowRetryModelSelection extends WorkflowModelSelection {
	/** Retry count threshold where this selection begins applying; 0 is the first attempt. */
	retry: number;
}

export interface WorkflowStep {
	id: string;
	title?: string;
	prompt: Templatable;
	/** Model reference for this main harness turn. Supports pi's provider/id and optional :<thinking> shorthand. */
	model?: string;
	/** Thinking level for this main harness turn. Omitted steps use the workflow-start default. */
	thinkingLevel?: WorkflowThinkingLevel;
	/** Retry-based main-harness model/thinking overrides. Highest retry <= current retry count wins. */
	retryModelSelections?: WorkflowRetryModelSelection[];
	skipIf?: (ctx: WorkflowContext) => boolean | Promise<boolean>;
	/** Run this step's prompt once per item. */
	forEach?: WorkflowForEach;
	checks?: Check[];
	/** Capture this step's output from a named check's stdout/stderr text. */
	outputFrom?: string;
	/** Default for this step's checks. */
	onFail?: OnFailPolicy;
}

export interface WorkflowDefinition {
	/** Must match /^[a-z0-9-]+$/. */
	name: string;
	description?: string;
	defaults?: {
		onFail?: OnFailPolicy;
		maxLoops?: number;
	};
	steps: WorkflowStep[];
}

export function defineWorkflow(def: WorkflowDefinition): WorkflowDefinition {
	return def;
}
