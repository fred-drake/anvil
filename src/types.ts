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
	 * Intended max concurrent item sessions. Defaults to 1 (sequential). Parallel fan-out is not
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

/** Terminal-multiplexer backend Anvil can spawn subagent sessions in. */
export type WorkflowSubagentBackend = "cmux" | "herdr";

/** Configuration for a fresh, independent agent-check reviewer. */
export type AgentReviewMode =
	| { subagent: WorkflowSubagentBackend }
	| { subagent: "auto" };

export type WorkflowDelegation =
	| "auto"
	| "none"
	| {
			/** Pi skill name to prefer when delegating this workflow/step. */
			skill: string;
	  }
	| {
			/** Anvil spawns the step itself in a dedicated subagent session on this backend. */
			subagent: WorkflowSubagentBackend;
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
	/** Subagent to delegate evaluation to; omit for main-agent evaluation. */
	agent?: string;
	/**
	 * Run this check in a fresh review-only subagent. The reviewer receives only
	 * bounded current-attempt observable output, never general workflow outputs.
	 */
	review?: AgentReviewMode;
	/** Behavior when no requested review backend is available. Defaults to "fail". */
	reviewFallback?: "main" | "fail";
	/** Defaults to 300_000 for main-session grading and 1_800_000 for independent review. */
	timeoutMs?: number;
	onFail?: OnFailPolicy;
}

export type Check = DeterministicCheck | AgentCheck;

export interface WorkflowModelSelection {
	/** Model reference. Supports pi's provider/id and optional :<thinking> shorthand. */
	model?: string;
	/** Thinking level. Omitted values keep the workflow-start or base step default. */
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
	/** Model reference for this step. Supports pi's provider/id and optional :<thinking> shorthand. */
	model?: string;
	/** Thinking level for this step. Omitted steps use the workflow-start default. */
	thinkingLevel?: WorkflowThinkingLevel;
	/** Retry-based model/thinking overrides. Highest retry <= current retry count wins. */
	retryModelSelections?: WorkflowRetryModelSelection[];
	/** Preferred per-step delegation mode; overrides workflow.defaults.delegation. */
	delegation?: WorkflowDelegation;
	/** Timeout for declarative subagent execution. Defaults to 1_800_000ms. */
	subagentTimeoutMs?: number;
	/** Legacy delegation hint. Prefer delegation: { skill: "..." } or delegation: "auto". */
	agent?: string;
	/** Main agent does the work itself. */
	runInMain?: boolean;
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
		/** Preferred workflow-wide delegation mode; defaults to auto-detected delegation. */
		delegation?: WorkflowDelegation;
		/** Default timeout for declarative subagent execution. Defaults to 1_800_000ms. */
		subagentTimeoutMs?: number;
		/** Legacy delegation hint. Prefer delegation: { skill: "..." } or delegation: "auto". */
		agent?: string;
		onFail?: OnFailPolicy;
		maxLoops?: number;
	};
	steps: WorkflowStep[];
}

export function defineWorkflow(def: WorkflowDefinition): WorkflowDefinition {
	return def;
}
