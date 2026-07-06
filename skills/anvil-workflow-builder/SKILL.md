---
name: anvil-workflow-builder
description: Use when the user wants to create or edit an automated multi-step workflow with gated checks.
---

# Anvil Workflow Builder

Help the user author a declarative pi-anvil workflow. Interview them first, then write a workflow file and validate it.

## Interview flow

1. Choose a workflow name (`[a-z0-9-]+`) and a one-sentence goal.
2. Ask whether the workflow should live at user scope (`~/.pi/agent/anvil/workflows/`) or project scope (`.pi/anvil/workflows/`).
3. For each step, capture:
   - `id` (stable kebab-case identifier)
   - purpose / prompt
   - subagent name (`agent`) or `runInMain: true`
4. For each step, ask whether it needs checks:
   - deterministic checks: bash command, optional timeout/cwd
   - agent checks: natural-language criteria and optional evaluation subagent
5. For failures, choose `stop`, `continue`, or `{ goto, maxLoops, onExhausted, feedback }`.
6. Confirm a concise summary before writing the file.

## Template

Prefer the import form when possible:

```ts
import { defineWorkflow } from "pi-anvil";

export default defineWorkflow({
	name: "example-workflow",
	description: "Short description.",
	defaults: {
		agent: "implementer",
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

Write the file to the chosen workflows directory, run `/anvil validate <name>`, fix any errors, and tell the user the invocation:

```text
/anvil run <name> <task input>
```
