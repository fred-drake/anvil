# Anvil Feature Backlog

Proposed features for future implementation, listed in **implementation order**: top to
bottom is the recommended build sequence, respecting dependencies and value-to-effort.
Each entry notes the motivation, a sketch of the design, the files likely to change, and
the main risks. Sequencing also reflects alignment with Anvil's stated purpose:
deterministic, gated workflows that run without babysitting.

Value is judged on: does it close a gap the docs already admit, does it unlock capability
that is otherwise impossible, and how much risk does it add.

Each feature below links to a detailed implementation plan in
[`docs/features/`](features/). A feature's number is a stable identifier that preserves
references after shipped entries are removed. Shipped features move to [Shipped](#shipped)
at the bottom.

---

## 5. `/anvil plan` (dry-run resolution)

📄 **Detailed plan:** [`features/05-dry-run-plan.md`](features/05-dry-run-plan.md)

**Why:** `validate` confirms a workflow is structurally sound but does not show how it
will actually behave. Delegation `auto` resolves differently depending on environment
(`HERDR_ENV`, `CMUX_SHELL_INTEGRATION`), and per-step and retry model selections are
easy to get wrong. A dry-run that prints the resolved plan catches "this won't delegate
the way I think" before a real run burns time and tokens.

**Current state:** `resolveStepDelegation` (`src/prompts.ts`) and
`resolveStepModelSelection` (`src/engine.ts`) already compute these; nothing surfaces
the resolved values.

**Design sketch:**
- Add `/anvil plan <name>` (or a `--plan` flag on `validate`) that prints, per step:
  effective model/thinking, resolved delegation (and which backend `auto` lands on in
  the current environment), check types and their `onFail` policies, and any
  `retryModelSelections` that would apply.
- No side effects; never spawns subagents or runs commands.

**Files:** `src/index.ts`, `src/validate.ts`, `src/ui.ts`, `test/validate.test.ts`,
`test/anvil-command.test.ts`, `README.md`.

**Risks:** Low. Must reuse the real resolution functions so the preview cannot drift
from actual run behavior.

---

## 6. Named input parameters

📄 **Detailed plan:** [`features/06-named-input-parameters.md`](features/06-named-input-parameters.md)

**Why:** `/anvil run <name> ...` takes a single free-form string, and templating is
limited to `{input}`. Workflows that need structured inputs (`{ticket}`, `{branch}`)
have to parse them out of the free text, as `examples/workflows/demo.ts` does with a
regex. A declared param schema makes templating reliable and improves completions.

**Current state:** Only `{input}` interpolation exists; no param declaration or
validation.

**Design sketch:**
- Add an optional `params` schema to `WorkflowDefinition` (name, required flag,
  description, optional default).
- Validate provided params in `validate` and at run start; report missing required
  params clearly.
- Expose params to `Templatable` alongside `{input}` (keep `{input}` for the raw text).
- Feed param names into completions.

**Files:** `src/types.ts`, `src/validate.ts`, `src/engine.ts`, `src/prompts.ts`,
`src/index.ts` (arg parsing + completions), `skills/anvil-workflow-builder/SKILL.md`,
`README.md`, tests.

**Risks:** Public-contract change. Keep fully backward compatible: workflows with no
`params` behave exactly as today.

---

## 8. Lifecycle hooks and completion notifications

📄 **Detailed plan:** [`features/08-lifecycle-hooks.md`](features/08-lifecycle-hooks.md)

**Why:** Anvil is designed to run "without babysitting," but nothing happens when a run
finishes unattended. Lifecycle hooks let a workflow commit, clean up, or notify on
completion, which is the natural payoff of long autonomous runs.

**Current state:** The engine emits checkpoints and posts a summary, but there is no
user-defined hook surface.

**Design sketch:**
- Add optional workflow-level hooks: `onStepEnd`, `onComplete`, `onFail`, each a
  deterministic command or a small handler.
- Optionally emit a push notification on `run_end` (there is a `PushNotification`
  capability in the harness).
- Run hooks through the existing centralized shell helpers; never inline user input.

**Files:** `src/types.ts`, `src/engine.ts`, `src/shell.ts`, `src/index.ts`,
`README.md`, tests.

**Risks:** Hook failures must not corrupt run state; define whether a failing
`onComplete` affects the final status. Keep shell quoting centralized per `AGENTS.md`.

---

## 9. Whole-workflow timeout / budget

📄 **Detailed plan:** [`features/09-workflow-timeout-budget.md`](features/09-workflow-timeout-budget.md)

**Why:** Individual steps and checks have timeouts, but a whole run can loop within its
`maxLoops` budgets for a long time. A global ceiling gives unattended runs a hard stop.

**Current state:** `timeoutMs` exists per deterministic check and per agent check, and
`subagentTimeoutMs` per step, but there is no workflow-wide limit.

**Design sketch:**
- Add a top-level `limits` block (`maxDurationMs` and/or a total-retry budget) to
  `WorkflowDefinition` — run-scoped ceilings, not per-step defaults.
- Enforce in the engine run loop; abort with a clear terminal state recorded in the
  `run_end` checkpoint so history reflects the timeout.

**Files:** `src/types.ts`, `src/engine.ts`, `README.md`, `test/engine.test.ts`.

**Risks:** Low to moderate. Ensure abort path reuses existing `AnvilAbortError`
handling and records a distinct failure reason.

---

## 10. Workflow composition (sub-workflows)

📄 **Detailed plan:** [`features/10-workflow-composition.md`](features/10-workflow-composition.md)

**Why:** Workflows cannot reuse other workflows. Composition would let common sequences
(setup, verify, release) be factored out and shared, reducing duplication as a project
accumulates workflows.

**Current state:** Each workflow is a flat, independent step list; no invocation of one
workflow from another.

**Design sketch:**
- Allow a step to invoke another discovered workflow as a sub-run, forwarding input (or
  named params from feature #6) and surfacing its summary as a step output (the shipped
  step outputs).
- Guard against cycles during discovery/validation.
- Decide how sub-run checkpoints nest in the append log so history/resume stay coherent.

**Files:** `src/types.ts`, `src/engine.ts`, `src/discovery.ts`, `src/validate.ts`,
`src/index.ts`, `README.md`, tests.

**Risks:** Higher complexity. Depends on the shipped step outputs and ideally feature #6
(params) to be worth doing. Cycle detection and checkpoint nesting need care. Recall the
security note in `README.md`: discovery imports workflow modules, so composition must not
widen the trust surface.

---

## Notes on sequencing

The list above is already in build order. The dependencies driving it:

- **#5 (dry-run), #8 (hooks), #9 (budget)** are largely independent quality-of-life —
  orderable to taste.
- **#6 (named params)** is a `WorkflowDefinition` contract change and a prerequisite for
  #10.
- **#10 (composition) last** — highest complexity, and depends on #6 (params) plus the
  shipped step outputs.

Every contract change must keep the synchronized-update discipline in `AGENTS.md`:
`src/types.ts`, `src/validate.ts`, `src/engine.ts`, tests, `README.md`,
`skills/anvil-workflow-builder/SKILL.md`, and `examples/workflows/demo.ts`.

---

## Shipped

Features that have landed. Kept here so the cross-references above (and inside
[`docs/features/`](features/)) still resolve; their detailed plans remain as design
records.

- **Mid-run reload and id-based resume** — Phase 1 shipped in `c5d4623`; opt-in
  `/anvil run --watch` Phase 2 shipped in `310cecf`. Resume reconciles by stable step id
  and rehydrates outputs; watch reloads only valid, canonical workflow changes between
  outer steps. Plan: [`features/03-mid-run-reload.md`](features/03-mid-run-reload.md).
- **Step outputs / data passing between steps** — shipped in `8efa1b7`.
  `WorkflowContext.outputs` (keyed by step id), `{outputs.<id>}` / `ctx.outputs`
  templating, and `outputFrom` deterministic capture. Plan:
  [`features/shipped-step-outputs.md`](features/shipped-step-outputs.md).
- **Per-item fan-out (`forEach` steps)** — shipped in `3fe8f83`.
  Runs one subagent attempt per deterministic item with per-item retries, templating,
  checks, and progress. Plan: [`features/07-per-item-fanout.md`](features/07-per-item-fanout.md).
- **`/anvil history` and per-run reports** — shipped in `40379ca`.
  Provides bounded checkpoint-backed run history and detailed markdown reports. Plan:
  [`features/02-history-and-run-reports.md`](features/02-history-and-run-reports.md).
