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
3. For each step, capture:
   - `id` (stable kebab-case identifier)
   - purpose / prompt
   - If the user expresses subagent intent, ask whether this step or check prompt should request subagents. Encode the request directly in ordinary prompt text, for example `Use subagents to implement this change.` Do not emit a schema field. The active harness's skills and plugins own agent selection and lifecycle.
   - optional per-step `model` and/or `thinkingLevel`. Pi's thinking shorthand is colon-based (`provider/model:high`, not `provider/model/high`). Supported `thinkingLevel` values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Omitted model/thinking values use the workflow-start defaults.
   - optional `retryModelSelections` when the user wants retry-aware model or thinking changes. `retry: 0` is the first attempt; `retry: 1` is the first retry. The highest retry less than or equal to the current retry count wins, and omitted fields fall back to the step's regular model/thinking. These selections affect the main harness turn and do not automatically select models for children.
   - whether the step should pass text to later steps. Later templates can reference prior outputs as `{outputs.<step-id>}` or `ctx.outputs["<step-id>"]`; missing outputs are empty, and retry loops overwrite with the latest attempt. Resume matches the historical target by step id for its suggestion, while an explicit `/anvil resume <step>` is positional against the current definition. Completed surviving steps before the target are skipped and their bounded snapshots are restored by id; newly inserted or otherwise pending pre-target steps execute first, while the retry seed stays attached to the selected target. Target and downstream outputs are cleared. Session checkpoints are locally editable input, structurally validated and capped at 8 KiB UTF-8 bytes but not authenticated, so hostile checkpoint modification can inject restored prompt text. Raw snapshots never belong in maps, history, reports, summaries, or diagnostics. A step captures harness-reported text only when the harness calls `anvil_output`, including when its prompt requested subagents. For deterministic capture, set `outputFrom: "<check-id>"` on the step so that check's command output becomes the step output.
4. For each step, determine whether it has gating checks.
   - If the user explicitly provides one or more checks for the step, capture them.
   - If the user explicitly says the step has no check / no gate, record no `checks` for that step without asking again.
   - If they are not explicit about whether there is no gating check for the step, ask with a picker: add a gating check, or no gating check.
5. For each gating check, determine its type and details.
   - Explain that checks may be deterministic or non-deterministic.
   - Deterministic checks: a repeatable command or script, optional timeout/cwd. String commands render `{input}`, `{loop}`, and `{outputs.<step-id>}` as quoted shell-variable expansions before running; function commands must quote any context values they interpolate. If the user says that a bash command must run successfully, treat it as implicitly deterministic.
   - Non-deterministic checks: natural-language criteria judged by the active harness turn, with optional `timeoutMs` (default 300,000ms). Agent checks must call `anvil_verdict` with the exact check id supplied by Anvil; prose alone does not pass the gate.
   - When independence matters and the user wants it, put the request in the check prompt, for example: `Use a fresh review subagent to independently verify the implementation, then submit the exact anvil_verdict for this check.` Do not add a review schema field. Harness skills and plugins decide whether the request is honored, so Anvil cannot verify independence or verdict provenance.
   - If the user is not explicit about whether a check is deterministic and it is not completely obvious, ask with a picker: deterministic command/script check, or non-deterministic agent-judged check.
   - If the deterministic check does not name a script or command that already exists somewhere, offer to write the script/command for them as part of creating the workflow.
6. For failures, choose `stop`, `continue`, or `{ goto, maxLoops, onExhausted, feedback }`. Make clear that `onFail: "continue"` advances to the next workflow step immediately and skips any remaining checks on the current step.
7. Confirm a concise summary before writing the file.

## Per-item fan-out (`forEach`)

When a step's work is really "do this same thing to each of N items" — especially for small or local models that cannot hold a whole feature at once — propose a `forEach` step. The engine loops over the items deterministically and starts one harness turn per item.

- Source the items deterministically when you can. The strongest pattern is a prior plan step gated by a deterministic check that its emitted list parses, then `items: { command: "cat <list-file>", parse: "lines" }`. A function source (`items: (ctx) => JSON.parse(ctx.outputs["plan"]).files`) pairs with step outputs; it must return an array of strings.
- Keep each per-item prompt single-outcome. Write the prompt for one item ("write test stubs for `{item}`"), not for the batch. Use `{item}`, `{itemIndex}` (zero-based), and `{itemCount}`; these are empty outside a `forEach` step.
- If the user wants isolation, put a request such as `Use subagents to handle {item}` directly in the per-item prompt. The harness owns agent selection and lifecycle; do not promise a fresh child session.
- Scope checks to the item (`command: "npx vitest run {item}"`). A check's `onFail: { goto }` must target the step itself — that retries just that item with its own feedback. Do not `goto` another step from inside a `forEach`; validation rejects it.
- Use `onItemExhausted: "continue"` when the user wants a best-effort sweep that reports failures rather than stopping at the first bad item; the step still fails if every item fails. `maxItems` caps enumeration. `outputFrom` is not available on a `forEach` step (its output is an automatic per-item digest).
- Concurrency is sequential today; do not promise parallel fan-out.

See `examples/workflows/fan-out.ts` for the full plan → gate → fan-out shape.

## Template

Prefer the import form when possible:

```ts
import { defineWorkflow } from "anvil";

export default defineWorkflow({
	name: "example-workflow",
	description: "Short description.",
	defaults: {
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
			outputFrom: "tests", // optional: expose this check's output as {outputs.implement}
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
	steps: [{ id: "step-one", prompt: "Do this: {input}" }],
};
```

## Finish

Write the file to the chosen Anvil workflow path (`~/.pi/agent/anvil/workflows/<name>.ts` or `.pi/anvil/workflows/<name>.ts`), run `/anvil validate <name>`, fix any errors, and tell the user the invocation:

```text
/anvil run <name> <task input>
```

For local development only, the user may explicitly choose `/anvil run --watch <name> <task input>`. Explain that watch mode is nondeterministic and checks a filesystem signature at outer step boundaries—never during a step or `forEach` item—then fresh-imports only the originally selected, canonical-path-pinned trusted workflow module when its workflow-root inputs changed. Broken or invalid candidates (including dangling `onFail.goto`) retain the last valid definition and emit a bounded warning. Valid edits reconcile completed/skipped state and outputs by stable step id, preserve an explicit pending `goto` by target id, discard removed outputs, and run newly inserted pending steps in current-definition order; active-definition titles, totals, routing, models, status, and summaries then apply. Checkpoint provenance is a revision counter only and contains no definition-derived fingerprint. Watch is not a workflow schema field and is never enabled for ordinary run/resume. Do not recommend it for untrusted projects or deterministic unattended runs.
