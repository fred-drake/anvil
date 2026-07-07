export interface WorkflowContext {
	/** Free-form text from `/anvil run <name> ...`. */
	input: string;
	step: { id: string; index: number };
	/** "<checkId>-><stepId>" -> count. */
	loopCounts: Record<string, number>;
	cwd: string;
}

export type Templatable = string | ((ctx: WorkflowContext) => string | Promise<string>);

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
	onFail?: OnFailPolicy;
}

export type Check = DeterministicCheck | AgentCheck;

export interface WorkflowStep {
	id: string;
	title?: string;
	prompt: Templatable;
	/** Model reference for this step. Supports pi's provider/id and optional :<thinking> shorthand. */
	model?: string;
	/** Thinking level for this step. Omitted steps use the workflow-start default. */
	thinkingLevel?: WorkflowThinkingLevel;
	/** Preferred per-step delegation mode; overrides workflow.defaults.delegation. */
	delegation?: WorkflowDelegation;
	/** Timeout for declarative subagent execution. Defaults to 1_800_000ms. */
	subagentTimeoutMs?: number;
	/** Legacy delegation hint. Prefer delegation: { skill: "..." } or delegation: "auto". */
	agent?: string;
	/** Main agent does the work itself. */
	runInMain?: boolean;
	skipIf?: (ctx: WorkflowContext) => boolean | Promise<boolean>;
	checks?: Check[];
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
