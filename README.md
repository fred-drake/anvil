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
/anvil config
/anvil run <name> <free-form task input>
/anvil abort
```

`/anvil run` delegates steps through the configured subagent tool when available. If no subagent tool is configured, Anvil auto-detects a tool named `subagent`, asks you to pick one, or can run all steps in the main agent.

## Workflow example

```ts
import { defineWorkflow } from "pi-anvil";

export default defineWorkflow({
	name: "demo",
	defaults: { agent: "implementer", maxLoops: 2 },
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
