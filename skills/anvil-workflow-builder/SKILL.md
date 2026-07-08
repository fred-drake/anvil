---
name: anvil-workflow-builder
description: Use when the user wants to create or edit an automated multi-step workflow with gated checks.
---

# Anvil Workflow Builder

Help the user author a declarative anvil workflow. Interview them first, then write a workflow file and validate it.

## Storage policy

Anvil workflows must be stored only in Anvil's workflow directories:

- User scope: `~/.pi/agent/anvil/workflows/<name>.ts`
- Project scope: `.pi/anvil/workflows/<name>.ts`

Do not write Anvil workflows to Pi's generic workflow locations such as `.pi/workflows/saved/` or `~/.pi/workflows/saved/`; those belong to other workflow implementations and may conflict.

## Interview flow

Guide the user with pickers when Anvil-specific choices are missing. The user may know the desired workflow but not Anvil's required structure, so do not silently guess for ambiguous scope or gate choices.

1. Choose a workflow name (`[a-z0-9-]+`) and a one-sentence goal.
2. Determine workflow scope.
   - If the user explicitly says user/global/personal scope, use user scope (`~/.pi/agent/anvil/workflows/<name>.ts`).
   - If the user explicitly says project/repo/local scope, use project scope (`.pi/anvil/workflows/<name>.ts`).
   - If they do not specifically name the user or project scope, ask with a picker containing exactly these two choices: user scope or project scope.
3. Decide workflow delegation defaults:
   - Default to `delegation: "auto"` unless the user specifically chooses otherwise; auto detects `HERDR_ENV=1` as herdr first, then `CMUX_SHELL_INTEGRATION=1` as cmux, and otherwise lets the main agent proceed.
   - `delegation: { subagent: "cmux" }` — Anvil itself spawns each step in a dedicated pi subagent session inside a cmux surface (declarative; requires running pi inside cmux). Per-step `model`/`thinkingLevel` are passed to the subagent.
   - `delegation: { subagent: "herdr" }` — Anvil itself spawns each step in a dedicated pi subagent session inside a herdr pane/tab (declarative; requires running pi inside herdr). Per-step `model`/`thinkingLevel` are passed to the subagent.
   - `delegation: { skill: "<skill-name>" }` — prompt hint to prefer a specific skill (the main agent decides).
   - `delegation: "auto"` — auto-detect herdr/cmux subagent support from the environment.
   - `delegation: "none"` — avoid subagents.
4. For each step, capture:
   - `id` (stable kebab-case identifier)
   - purpose / prompt
   - optional per-step `model` and/or `thinkingLevel`. Pi's thinking shorthand is colon-based (`provider/model:high`, not `provider/model/high`). Supported `thinkingLevel` values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Omitted model/thinking values use the workflow-start defaults.
   - optional `retryModelSelections` when the user wants retry-aware model or thinking changes. `retry: 0` is the first attempt; `retry: 1` is the first retry. The highest retry less than or equal to the current retry count wins, and omitted fields fall back to the step's regular model/thinking. These selections affect main-session steps and declarative subagent launches.
   - optional `subagentTimeoutMs` on workflow defaults or individual steps that use declarative subagent delegation (defaults to 1,800,000ms).
   - optional per-step `delegation` override or `runInMain: true`
5. For each step, determine whether it has gating checks.
   - If the user explicitly provides one or more checks for the step, capture them.
   - If the user explicitly says the step has no check / no gate, record no `checks` for that step without asking again.
   - If they are not explicit about whether there is no gating check for the step, ask with a picker: add a gating check, or no gating check.
6. For each gating check, determine its type and details.
   - Explain that checks may be deterministic or non-deterministic.
   - Deterministic checks: a repeatable command or script, optional timeout/cwd. String commands render `{input}` and `{loop}` as quoted shell-variable expansions before running; function commands must quote any context values they interpolate. If the user says that a bash command must run successfully, treat it as implicitly deterministic.
   - Non-deterministic checks: natural-language criteria judged by an agent, optional evaluation subagent, and optional `timeoutMs` (defaults to 300,000ms). Main-session agent checks are self-graded by the same main agent, so they are not independent reviews.
   - If the user is not explicit about whether a check is deterministic and it is not completely obvious, ask with a picker: deterministic command/script check, or non-deterministic agent-judged check.
   - If the deterministic check does not name a script or command that already exists somewhere, offer to write the script/command for them as part of creating the workflow.
7. For failures, choose `stop`, `continue`, or `{ goto, maxLoops, onExhausted, feedback }`. Make clear that `onFail: "continue"` advances to the next workflow step immediately and skips any remaining checks on the current step.
8. Confirm a concise summary before writing the file.

## Subagent pane command portability

Declarative subagent launches run inside user terminal panes, so generated launch commands must be portable across the user shells that Herdr or cmux may open.

- Do not emit raw `$?` or other bash-only syntax directly into pane commands.
- Wrap generated subagent launch commands in `bash -lc` when relying on POSIX/bash syntax for setup, exit-status capture, or sentinel output.
- Include fish-shell parse compatibility in subagent command regression tests when command-generation behavior changes.
- When adding terminal-screen fallback detection for subagent startup/errors, match the full prompt shape instead of a single phrase that an agent might quote while inspecting issues or logs.
- Add regression tests for false positives when subagent output contains sentinel-like strings or documented startup error text.

## Template

Prefer the import form when possible:

```ts
import { defineWorkflow } from "anvil";

export default defineWorkflow({
	name: "example-workflow",
	description: "Short description.",
	defaults: {
		delegation: "auto",
		onFail: "stop",
		maxLoops: 3,
	},
	steps: [
		{
			id: "implement",
			title: "Implement the change",
			model: "openai-codex/gpt-5.5:high",
			retryModelSelections: [
				{ retry: 0, model: "openai-codex/gpt-5.5:minimal" }, // first attempt
				{ retry: 1, model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
			],
			prompt: "Implement this request: {input}",
			checks: [
				{
					type: "deterministic",
					id: "tests",
					name: "Test suite",
					command: "npm test",
					onFail: { goto: "implement", maxLoops: 2, feedback: true },
				},
			],
		},
	],
});
```

If TypeScript module resolution is awkward, a plain object default export is also valid:

```ts
export default {
	name: "example-workflow",
	steps: [{ id: "step-one", runInMain: true, prompt: "Do this: {input}" }],
};
```

## Finish

Write the file to the chosen Anvil workflow path (`~/.pi/agent/anvil/workflows/<name>.ts` or `.pi/anvil/workflows/<name>.ts`), run `/anvil validate <name>`, fix any errors, and tell the user the invocation:

```text
/anvil run <name> <task input>
```
