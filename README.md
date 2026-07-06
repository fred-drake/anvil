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

`/anvil run` uses each workflow's delegation settings. Anvil does not configure a global subagent tool; use `delegation` in the workflow to prefer a skill, let the agent decide, or disable delegation.

```ts
defaults: { delegation: { skill: "implementer" } } // prefer a specific skill
defaults: { delegation: "auto" }                 // let the agent decide
defaults: { delegation: "none" }                 // never delegate
```

Steps can override the workflow default with their own `delegation`, and `runInMain: true` still forces a step to run in the main agent.

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
