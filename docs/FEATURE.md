# Anvil Feature Backlog

Proposed features for future implementation, listed in **implementation order**: top to
bottom is the recommended build sequence, respecting dependencies and value-to-effort.
Each entry notes the motivation, a sketch of the design, the files likely to change, and
the main risks. Sequencing also reflects alignment with Anvil's stated purpose:
deterministic, gated workflows that run without babysitting.

Value is judged on: does it close a gap the docs already admit, does it unlock capability
that is otherwise impossible, and how much risk does it add.

Each feature below links to a detailed implementation plan in
[`docs/features/`](features/). A feature's number is its position in the build order.
Shipped features move to [Shipped](#shipped) at the bottom.

---

## 1. Independent fresh-subagent review for agent-judged checks

📄 **Detailed plan:** [`features/01-independent-subagent-review.md`](features/01-independent-subagent-review.md)

**Why:** This is the one honesty gap the project already admits. `README.md` states
that main-session agent-judged checks are self-graded by the same agent that
performed the step, so they "cannot structurally prevent a rubber-stamp
`pass: true`," and it explicitly teases a "future fresh-subagent review pattern
when independence matters." Closing this makes agent gates trustworthy rather than
advisory.

**Current state:** `AgentCheck` (`src/types.ts`) already has an optional `agent?`
field, but there is no mechanism to force an *independent* reviewer that is distinct
from the step's executor and does not share its context. The cmux/herdr subagent
runner (`src/subagent/`) already knows how to spawn a clean session.

**Design sketch:**
- Add an option on `AgentCheck` to require independent evaluation, e.g.
  `independent: true` or `review: { subagent: "cmux" | "herdr" | "auto" }`.
- When set, the check spawns a fresh subagent session (reusing `src/subagent/runner.ts`)
  that receives only the step's declared criteria and the observable result, not the
  executor's conversation.
- The reviewer returns a structured verdict from the child session (the detailed plan
  recommends a `<sessionFile>.verdict.json` sidecar written by the child extension,
  since the child is a separate pi process with no access to the parent's `VerdictBus`);
  the parent converts it into the existing `GateResult` shape so downstream plumbing
  stays unchanged.
- When no subagent backend is available, fail the check by default with a clear reason
  (silent self-grading would reintroduce the rubber-stamp this feature removes); a
  workflow can opt into falling back to main-session evaluation.

**Files:** `src/types.ts`, `src/gates.ts`, `src/engine.ts`, `src/subagent/*`,
`src/validate.ts`, tests in `test/gates.test.ts` and `test/subagent.test.ts`,
`README.md`, `skills/anvil-workflow-builder/SKILL.md`.

**Risks:** Requires a subagent backend to be present; must clearly define what context
the reviewer is and is not given so the independence guarantee is real. Add tests that
assert the reviewer session does not inherit executor context.

---

## 2. `/anvil history` and per-run reports

📄 **Detailed plan:** [`features/02-history-and-run-reports.md`](features/02-history-and-run-reports.md)

**Why:** Anvil already persists everything needed, but nothing surfaces it. Runs emit
checkpoints via `pi.appendEntry("anvil-run", ...)` with phases `run_start`,
`step_start`, `check_result`, `step_pass`, and `run_end`, each carrying timestamps,
final state, and failure reasons. Today only `/anvil resume` replays that log. A
history view and run report is almost pure read-side work over data that already
exists, making it low risk and high polish.

**Current state:** Checkpoint reading logic already lives in `src/index.ts`
(`toAnvilCheckpoint`, the replay loop building `lastStartedStep` / `lastFailure`).

**Design sketch:**
- Add `/anvil history [name]` listing recent runs: run id, workflow, start time,
  duration (from `run_start` to `run_end`), final state, and the failing step when
  applicable.
- Add a per-run markdown report (reuse the existing `renderSummaryMarkdown` style)
  showing each step, its checks, verdicts, retry counts, and timings.
- Optionally cap or paginate output; keep formatting consistent with the current
  `/anvil resume` step map.

**Files:** `src/index.ts` (new subcommand + completions around the `subcommands`
array), `src/ui.ts` for formatting, tests in `test/anvil-command.test.ts` and
`test/completions.test.ts`, `README.md`.

**Risks:** Low. Mostly presentation. Watch for large append logs; consider limiting
how far back the replay scans.

---

## 3. Mid-run reload and id-based resume

📄 **Detailed plan:** [`features/03-mid-run-reload.md`](features/03-mid-run-reload.md)

**Why:** Two related gaps, one already latent and one new. First, resume is silently
unsafe across edits: `findLatestResumableRun` (`src/index.ts`) and `resolveResumeState`
(`src/engine.ts`) locate the resume point purely by numeric step index and never match it
back to a step id, so inserting, removing, or reordering steps between a failed run and
its resume drops you onto the wrong step with no error. Resume also starts `outputs` and
`feedbackByStep` empty, so a resumed run loses every prior step's captured output — and
now that step outputs (shipped) landed, that is real lost state, not just cosmetics.
Second, there is no way to edit a *running* workflow and have the engine pick up the
change: the definition is imported once at run start and never re-read, so tuning a
workflow means aborting and restarting. Closing both turns Anvil into something you can
train as you use it.

**Current state:** The loader already re-reads fresh — jiti with
`moduleCache: false, fsCache: false` (`src/discovery.ts`) — and every run/resume path
discovers with `useCache: false`, so re-importing to pick up edits is already solved at
the loader level. The obstacle is entirely in the engine: `runWorkflow` closes over
`options.workflow` and reads `options.workflow.steps[stepIndex]` each iteration but never
re-fetches, and the parallel `steps: StepRunState[]` array plus `stepIndex` are
index-addressed while all durable state (`loopCounts`, `outputs`, `feedbackByStep`,
checkpoints, `onFail.goto`) is keyed by `step.id`. No id↔index reconciliation exists
anywhere.

**Design sketch:**
- **Phase 1 — id-based resume (the priority).** Match the resume point by the last
  started step's id (checkpoints already carry `stepId`) against the current on-disk
  definition, instead of trusting `stepNumber - 1`. Rebuild the `StepRunState[]` array by
  id, preserving status/loops for surviving ids and marking genuinely new steps pending.
  Rehydrate `outputs` (and optionally feedback) for already-completed steps by folding the
  checkpoint stream — the same reader #2 builds. Fail with a clear message when the
  resume-target id no longer exists. Keep the existing positional `/anvil resume <n>`
  working for back-compat.
- **Phase 2 — dev-mode reload.** An opt-in (e.g. `/anvil run --watch` or a
  `reloadBetweenSteps` dev flag) that, at the top of the run loop — the one safe boundary,
  before the next step is read — re-discovers the workflow, re-runs `validateWorkflow`,
  and swaps `options.workflow` only if valid, keeping the previous definition and warning
  on a broken or mid-edit file. Reload takes effect only at step boundaries, never
  mid-step or mid-`forEach` item. Revalidate `onFail.goto` targets against the new
  definition and stamp a definition-version marker into each checkpoint so history and
  resume stay coherent across an edited run.

**Files:** `src/engine.ts` (id-based `resolveResumeState`, rebuild-`StepRunState`-by-id,
the reload hook at the loop head), `src/index.ts` (resume matching by id, output
rehydration shared with #2's reader, run/resume arg + flag parsing), `src/discovery.ts`
(re-discovery helper keyed by the existing mtime signature), `src/validate.ts`,
`src/types.ts` (only if a dev flag is surfaced on the definition), tests in
`test/engine.test.ts` and `test/anvil-command.test.ts`, `README.md`,
`skills/anvil-workflow-builder/SKILL.md`.

**Risks:** Phase 1 touches the resume/replay contract — it must stay backward compatible
with index-based `/anvil resume <n>` while adding id matching. Phase 2 is in real tension
with Anvil's deterministic, unattended thesis: a run stops being defined by (file +
input), so keep it strictly opt-in and dev-facing, and never let a reload of a broken file
corrupt a live run. Sequence after #2, whose checkpoint-folding reader is the natural
substrate for both id matching and output rehydration.

---

## 4. `/anvil status`

📄 **Detailed plan:** [`features/04-status-command.md`](features/04-status-command.md)

**Why:** A running workflow updates a live widget (`setWidget`/`formatStepWidget`), but
there is no command to inspect current progress on demand, for example after scrolling
away or reattaching.

**Current state:** Progress exists only as the ambient widget/status; no query command.

**Design sketch:**
- Add `/anvil status` that reports the active run (id, workflow, current step, retry
  count, elapsed) or states that nothing is running.
- Derive from the active-run state already tracked in `src/index.ts`
  (`getActiveRun`/`setActiveRun`) plus the latest checkpoints.

**Files:** `src/index.ts`, `src/ui.ts`, `test/anvil-command.test.ts`,
`test/completions.test.ts`, `README.md`.

**Risks:** Low. Mostly reads existing in-memory state. Shares the checkpoint-folding
reader with #2 — build it while that code is fresh.

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

## 7. Per-item fan-out (`forEach` steps)

📄 **Detailed plan:** [`features/07-per-item-fanout.md`](features/07-per-item-fanout.md)

**Why:** A step is one prompt executed by one agent session, so a step's scope must fit
one context window. That breaks down on small local models: "write test stubs for this
feature" exceeds what a 27B model can hold, and prompting the model to split the work
itself hands orchestration to the least reliable component. Engine-driven fan-out runs
a step's prompt once per item (typically per file) in a fresh subagent session each —
deterministic decomposition, bounded context per session, and per-item retry/feedback
and model escalation.

**Current state:** The run loop executes exactly one prompt per step
(`src/engine.ts`), and retry state (`loopCounts`, `feedbackByStep`) is keyed per step,
not per item. The cmux runner already manages multiple surfaces, so the spawning
infrastructure exists.

**Design sketch:**
- Add `forEach` to `WorkflowStep`: an item source (a function over `ctx` — typically
  parsing a prior step's output from the shipped step outputs — or a deterministic command
  whose stdout becomes the item list), plus `concurrency` (default 1), `maxItems`, and
  `onItemExhausted`.
- New `{item}` / `{itemIndex}` / `{itemCount}` template placeholders in prompts and
  (shell-safely) in check commands, so checks can gate each item individually
  (`npx vitest run {item}`).
- Per-item retry keys for loop counts and feedback; `onFail.goto` inside a `forEach`
  step may only target the step itself ("retry this item") in v1.
- Step output (the shipped step outputs) becomes a per-item digest; resume re-runs the
  whole step.

**Files:** `src/types.ts`, `src/validate.ts`, `src/engine.ts` (includes extracting a
single-attempt helper from the run loop first), `src/prompts.ts`, `src/ui.ts`,
`skills/anvil-workflow-builder/SKILL.md`, `README.md`, examples, broad tests.

**Risks:** The engine refactor touches the most intricate code in the project — land
it as a pure-move commit first. Item-qualified retry keys must not disturb existing
step-keyed behavior. Ship sequential-only first; parallel surfaces are proven for cmux
but not herdr.

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

- **#1 and #2 first** — high value with contained surface area; #2 is nearly pure
  read-side, and its checkpoint-folding reader is reused by #3 and #4.
- **#3 (mid-run reload / id-based resume) right after #2** — its phase 1 reuses #2's
  reader to match resume by step id and to rehydrate the shipped step outputs; phase 2
  (dev-mode reload) is strictly opt-in.
- **#4 (status)** also shares #2's reader; build it while that code is fresh.
- **#5 (dry-run), #8 (hooks), #9 (budget)** are largely independent quality-of-life —
  orderable to taste.
- **#6 (named params)** is a `WorkflowDefinition` contract change and a prerequisite for
  #10.
- **#7 (per-item fan-out)** builds on the shipped step outputs; the highest-value
  follow-up for small-context local models.
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

- **Step outputs / data passing between steps** — shipped in `8efa1b7`.
  `WorkflowContext.outputs` (keyed by step id), `{outputs.<id>}` / `ctx.outputs`
  templating, and `outputFrom` deterministic capture. Plan:
  [`features/shipped-step-outputs.md`](features/shipped-step-outputs.md).
