# Feature 5 — `/anvil plan` (dry-run resolution)

Back to [Feature backlog](../FEATURE.md#5-anvil-plan-dry-run-resolution).

## Summary

Add `/anvil plan <name>` that prints how a workflow *will* execute — effective
model/thinking per step, check types and `onFail` policies, and applicable retry model
selections — without running anything or sending harness instructions.

## Motivation

`validate` confirms a workflow is structurally sound but not how it will behave.
Per-step and retry model selection is easy to get wrong. A dry run that reuses the
*real* resolution functions catches "this won't switch models on retry" before a run
burns time and tokens.

## Current state (grounding)

- Model resolution: `resolveStepModelSelection(step, retryCount)` (`src/engine.ts:475`)
  merges base model/thinking with the winning `retryModelSelections` entry
  (`selectRetryModelSelection`, `src/engine.ts:486`) and understands the `model:thinking`
  shorthand (`parseModelReference`, `src/engine.ts:509`).
- Command plumbing: `handleValidate` (`src/index.ts:471`), `findWorkflow`
  (`src/index.ts:489`), `postCommandMessage` (`src/index.ts:494`), and the completion
  `subcommands` array (`src/index.ts:544`).

## Design

### `/anvil plan <name>` → `handlePlan`

Mirror `handleValidate`: find the workflow, bail on validation errors with
`formatWorkflowErrors`, otherwise render a plan built by a new pure formatter.

For each step, the plan renders:

- **Step**: `n. <title> (`id`)`, `skipIf` presence noted (can't evaluate — it's a runtime
  function of `ctx`).
- **Model/thinking**: `resolveStepModelSelection(step, 0)` for the base attempt, plus, if
  `retryModelSelections` exist, a compact table of `retry >= k → model/thinking` derived
  by evaluating `resolveStepModelSelection(step, k)` for each declared threshold `k`.
- **Checks**: each check's `type`, display name (`name ?? id`), and effective `onFail`
  resolved the same way the engine does (`check.onFail ?? step.onFail ??
  defaults.onFail ?? "stop"`, see `resolveFailure`, `src/engine.ts:440`), including
  `goto`/`maxLoops`/`onExhausted`.

Add the formatter to `src/ui.ts` (e.g. `renderWorkflowPlan(workflow)`) so it is unit
testable without reading environment state inside the formatter, keeping tests
deterministic per `AGENTS.md`.

### No side effects

`plan` must never call `host.exec` or `sendInstruction`. It only calls pure resolver
functions. This is the key correctness property from the backlog: the preview cannot
drift from real behavior because it calls the *same* resolvers the engine uses.

### Completions

Add `"plan"` to the `subcommands` array (`src/index.ts:544`) and extend the
`run`/`validate` name-completion branch (`src/index.ts:554`) to also match `plan`.

## Implementation steps

1. `src/ui.ts`: add `renderWorkflowPlan(workflow)`.
2. `src/index.ts`: add `handlePlan`, wire `case "plan":` into the switch
   (`src/index.ts:115`); add `"plan"` to subcommands and the name-completion condition.
3. Tests + README.

## Testing

- `test/ui.test.ts`: `renderWorkflowPlan` snapshots for retry model escalation tables,
  `skipIf` markers, and mixed check `onFail` resolution.
- `test/anvil-command.test.ts`: `plan` on a valid workflow posts an `anvil-plan` message;
  on an invalid one posts the validation errors; unknown name notifies not-found.
- `test/completions.test.ts`: `plan` in subcommands; `plan <prefix>` completes names.

## Docs to update

- `README.md`: add `/anvil plan <name>` to Commands.
- Optionally note in `skills/anvil-workflow-builder/SKILL.md` that authors can preview a
  workflow with `/anvil plan` after building it.

## Risks & open questions

- **Drift risk (mitigated by design).** Always call `resolveStepModelSelection` — never
  reimplement the logic in the formatter.
- **`skipIf` and function templates** cannot be evaluated statically; the plan should note
  their presence rather than pretend to resolve them.
- **Open question:** ship as a standalone `plan` subcommand (recommended, clearer
  completions) vs. a `--plan` flag on `validate`. The backlog allows either; a subcommand
  is cleaner.
