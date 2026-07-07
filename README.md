# pi-anvil

A Pi extension that runs declarative TypeScript workflows with deterministic and agent-judged gates.

Workflows live in:

- User: `~/.pi/agent/anvil/workflows/*.ts` (also `.js`/`.mjs`)
- Project: `.pi/anvil/workflows/*.ts` (project workflows win on name collisions)

## Develop

```bash
cd pi-anvil
npm install
npm run typecheck
npm test
npm run dev       # pi -e ./src/index.ts
```

## Commands

```text
/anvil list
/anvil validate <name>
/anvil run <name> <free-form task input>
/anvil abort
```

`/anvil run` uses each workflow's delegation settings. Anvil does not configure a global subagent tool; use `delegation` in the workflow to spawn a real subagent, prefer a skill, let the agent decide, or disable delegation.

```ts
defaults: { delegation: { subagent: "cmux" } }   // Anvil spawns each step in a cmux subagent
defaults: { delegation: { skill: "implementer" } } // prefer a specific skill (prompt hint)
defaults: { delegation: "auto" }                 // let the agent decide (prompt hint)
defaults: { delegation: "none" }                 // never delegate
```

Steps can override the workflow default with their own `delegation`, and `runInMain: true` still forces a step to run in the main agent.

## Declarative cmux subagents

`delegation: { skill }` and `delegation: "auto"` are advisory: they inject prose into the step prompt and the main agent decides whether to delegate. `delegation: { subagent: "cmux" }` is declarative: the Anvil engine itself spawns the step in a dedicated pi session inside a [cmux](https://github.com/manaflow-ai/cmux) surface, waits for it to finish, and reports its final message back into the main session as the step's outcome. The main agent never chooses.

Requirements and behavior:

- Start pi inside cmux (`cmux pi`). `/anvil run` refuses to start a workflow that declares `{ subagent: "cmux" }` when cmux is unavailable.
- The subagent runs in the project cwd with a fresh session; the first subagent opens a right split, later ones stack as tabs in the same pane. Session, task, and launch files live under `<tmpdir>/pi-anvil/<runId>/` for debugging.
- Per-step `model` / `thinkingLevel` are passed to the child session (`pi --model ... --thinking ...`) instead of switching the main session's model.
- The subagent's final assistant message is injected into the main session's context (no extra turn), so agent checks and later steps can build on it. Check loops still work: `onFail: { goto }` feedback is appended to the next subagent's task.
- A subagent that exits with an error (or a nonzero exit code) fails the run with that reason.
- Checks always run from the main session: deterministic checks via bash, agent checks via the main agent and `anvil_verdict`.

```ts
export default defineWorkflow({
	name: "forge",
	defaults: { delegation: { subagent: "cmux" } },
	steps: [
		{ id: "implement", model: "openai-codex/gpt-5.5:high", prompt: "Implement: {input}" },
		{ id: "summarize", runInMain: true, prompt: "Summarize what was changed." },
	],
});
```

## Per-step model selection

A step may declare a model and/or thinking level. Omitted values are reset to the model and thinking level that were active when the workflow started, so a previous step's model selection does not leak into later defaulted steps.

Pi's model shorthand uses a colon suffix for thinking levels: `provider/model:thinking` (for example, `openai-codex/gpt-5.5:high`). The slash form `provider/model/thinking` is not Pi's thinking-level syntax.

```ts
steps: [
	{ id: "quick-plan", model: "openai-codex/gpt-5.5:low", prompt: "Plan: {input}" },
	{ id: "deep-implement", model: "openai-codex/gpt-5.5", thinkingLevel: "high", prompt: "Implement: {input}" },
	{ id: "summarize", prompt: "Summarize the result" }, // uses workflow-start defaults
]
```

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

## Workflow example

```ts
import { defineWorkflow } from "pi-anvil";

export default defineWorkflow({
	name: "demo",
	defaults: { delegation: { skill: "implementer" }, maxLoops: 2 },
	steps: [
		{
			id: "implement",
			prompt: "Implement this request: {input}",
			checks: [
				{
					type: "deterministic",
					id: "tests",
					command: "npm test",
					onFail: { goto: "implement", maxLoops: 2 },
				},
			],
		},
	],
});
```

See `examples/workflows/demo.ts` and the `anvil-workflow-builder` skill for authoring guidance.
