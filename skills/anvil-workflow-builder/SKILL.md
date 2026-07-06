---
name: anvil-workflow-builder
description: Use when the user wants to create or edit an automated multi-step workflow with gated checks.
---

# Anvil Workflow Builder

Help the user author a declarative pi-anvil workflow. Interview them first, then write a workflow file and validate it.

## Storage policy

Anvil workflows must be stored only in Anvil's workflow directories:

- User scope: `~/.pi/agent/anvil/workflows/<name>.ts`
- Project scope: `.pi/anvil/workflows/<name>.ts`

Do not write Anvil workflows to Pi's generic workflow locations such as `.pi/workflows/saved/` or `~/.pi/workflows/saved/`; those belong to other workflow implementations and may conflict.

## Interview flow

1. Choose a workflow name (`[a-z0-9-]+`) and a one-sentence goal.
2. Ask whether the workflow should live at user scope (`~/.pi/agent/anvil/workflows/<name>.ts`) or project scope (`.pi/anvil/workflows/<name>.ts`).
3. Decide workflow delegation defaults: `delegation: { skill: "<skill-name>" }` to prefer a specific skill, `delegation: "auto"` to let the agent choose, or `delegation: "none"` to avoid subagents.
4. For each step, capture:
   - `id` (stable kebab-case identifier)
   - purpose / prompt
   - optional per-step `delegation` override or `runInMain: true`
5. For each step, ask whether it needs at least one gating check. Gating checks are recommended but not required; if a step has no check, explicitly ask the user to confirm or clarify.
   - Explain that checks may be deterministic or non-deterministic.
   - Deterministic checks: a repeatable command or script, optional timeout/cwd. If the user wants a deterministic check but no command exists, offer to write a script they can run.
   - Non-deterministic checks: natural-language criteria judged by an agent, optional evaluation subagent.
6. For failures, choose `stop`, `continue`, or `{ goto, maxLoops, onExhausted, feedback }`.
7. Confirm a concise summary before writing the file.

## Template

Prefer the import form when possible:

```ts
import { defineWorkflow } from "pi-anvil";

export default defineWorkflow({
	name: "example-workflow",
	description: "Short description.",
	defaults: {
		delegation: { skill: "implementer" },
		onFail: "stop",
		maxLoops: 3,
	},
	steps: [
		{
			id: "implement",
			title: "Implement the change",
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
