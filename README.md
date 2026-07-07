<p align="center">
  <img src="assets/anvil-logo.png" alt="Anvil logo" width="320">
</p>

# Anvil

A Pi extension that runs declarative TypeScript workflows with deterministic and agent-judged gates.

Anvil is for those Pi tasks where you keep thinking, “I want the agent to do this the same way every time, but I also want it to use judgment when a script cannot tell the whole story.” You can chain steps together, gate each step with hard pass/fail checks or agent-reviewed thumbs-up/thumbs-down checks, and keep the process moving without babysitting every turn.

## Features at a glance

- Build the workflow in your own words and Anvil will worry about how to properly build it.
- For each workflow step, set any number of gating checks that must pass. Checks can be deterministic, like a script or executable that returns exit code `0`, or non-deterministic, where a subagent evaluates the result and gives a 👍 or 👎 based on what it thinks should happen.
- Define subagent behavior based on how you have configured Pi. cmux and herdr compatibility come out of the box, you can choose a custom skill that you wrote for handling subagent processing, or no subagent at all if you wish.
- Optionally define the number of times a step has to be retried before bailing.
- Optionally define a different model and thinking level for each step.

## Build workflows by talking to Pi

The intended way to create a workflow is to describe what you want in plain language and let the agent shape it into something Anvil can run. This extension includes an `anvil-workflow-builder` skill that guides that conversation, asks for missing details when it needs them, and handles the workflow structure for you.

Although it follows a typescript schema under the hood, the intention is to say what the workflow should do in your own words. If Anvil needs exact commands, gating behavior, model choices, or delegation preferences, it will ask.

Workflows live in:

- User: `~/.pi/agent/anvil/workflows/*.ts` (also `.js`/`.mjs`)
- Project: `.pi/anvil/workflows/*.ts` (project workflows win on name collisions)

## Commands

```text
/anvil list
/anvil validate <name>
/anvil run <name> <free-form task input>
/anvil resume <step> [retry-number]
/anvil abort
```

Use `/anvil list` to see available workflows, `/anvil validate` to check that one is ready, and `/anvil run` to start a workflow with whatever task input you want to give it.

Use `/anvil resume` after a failed or aborted run to see a numbered step map, for example `1. Plan`, `2. Implement`, `3. Verify`. Then run `/anvil resume <step> [retry-number]` with the one-based step number to restart from that workflow step using the original task input. Omit `retry-number` for no retries, or pass a retry count to seed `{loop}` on the resumed step.

## Declarative subagents

Each workflow step can decide how much help it wants from another agent:

- Use the default `delegation: "auto"` to auto-detect the current subagent surface.
- Run as a declarative cmux subagent with `delegation: { subagent: "cmux" }`.
- Run as a declarative herdr subagent with `delegation: { subagent: "herdr" }`.
- Prefer a specific skill for the subagent to use.
- Do no delegation and keep the step in the main session.

For non-trivial work, sending the step into a subagent is strongly encouraged. It keeps the main session cleaner and gives that step room to focus. But it is your workflow, your rules: leave the default as `delegation: "auto"` when you want Anvil to detect the right visible Pi subagent backend, choose cmux or herdr explicitly when you want a fixed backend, use a skill when you have a custom way of doing the work, or turn delegation off entirely.

Auto detection prefers `HERDR_ENV=1` as herdr, then `CMUX_SHELL_INTEGRATION=1` as cmux. If neither variable is set, auto-delegated steps run in the main session with a prompt hint. If a workflow uses cmux subagents, start Pi inside cmux with `cmux pi` so Anvil has somewhere to launch them. If it uses herdr subagents, start Pi inside herdr so Anvil can create panes and tabs for each delegated step. Declarative cmux/herdr subagents are launched in Pi print mode and close their surface automatically when the step exits; if Pi stops at a startup prompt such as a missing saved cwd, Anvil reports the blocked launch instead of waiting for a timeout.

Checks still guard the workflow either way: deterministic checks run commands, while agent-judged checks ask for a clear pass/fail verdict before the workflow moves on.

See `examples/workflows/demo.ts` and the `anvil-workflow-builder` skill for authoring guidance.

## Develop

If you use nix, a nix dev environment is included with everything you need for development.

```bash
cd anvil
npm install
npm run typecheck
npm test
npm run dev       # pi -e ./src/index.ts
```
