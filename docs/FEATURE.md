# Anvil Feature Backlog

Proposed features for future implementation, ordered from most to least valuable.
Each entry notes the motivation, a sketch of the design, the files likely to change,
and the main risks. Ordering reflects value-to-effort and alignment with Anvil's
stated purpose: deterministic, gated workflows that run without babysitting.

Value is judged on: does it close a gap the docs already admit, does it unlock
capability that is otherwise impossible, and how much risk does it add.

Each feature below links to a detailed implementation plan in
[`docs/features/`](features/).

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

## 3. Step outputs / data passing between steps

📄 **Detailed plan:** [`features/03-step-outputs.md`](features/03-step-outputs.md)

**Why:** The single biggest capability gap. `WorkflowContext` (`src/types.ts`) exposes
only `input`, `step`, `loopCounts`, and `cwd`. A step cannot hand a value to a later
step's prompt or check, so every workflow that needs "plan then implement then verify
against the plan" has to smuggle state through the filesystem. First-class step outputs
unlock genuine multi-stage workflows.

**Current state:** No shared scratch or output channel exists between steps.

**Design sketch:**
- Extend `WorkflowContext` with `outputs: Record<string, string>` keyed by step id.
- Capture each step's subagent summary (already available as `SubagentStepRunResult.summary`)
  and, optionally, a deterministic check's stdout as the step output.
- Make outputs available to `Templatable` prompts/commands, e.g. `{outputs.plan}` or via
  the function form `(ctx) => ctx.outputs["plan"]`.
- Decide capture semantics for `runInMain` steps (no subagent summary exists there) and
  document them.

**Files:** `src/types.ts` (public contract), `src/engine.ts`, `src/prompts.ts`,
`src/gates.ts`, `src/validate.ts`, `examples/workflows/demo.ts`,
`skills/anvil-workflow-builder/SKILL.md`, `README.md`, broad test updates.

**Risks:** Public-contract change; must stay backward compatible with existing
workflows. Define output size limits and truncation. Plan and land this separately
from smaller features because of its surface area.

---

## 4. `/anvil plan` (dry-run resolution)

📄 **Detailed plan:** [`features/04-dry-run-plan.md`](features/04-dry-run-plan.md)

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

## 5. Named input parameters

📄 **Detailed plan:** [`features/05-named-input-parameters.md`](features/05-named-input-parameters.md)

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

## 6. Lifecycle hooks and completion notifications

📄 **Detailed plan:** [`features/06-lifecycle-hooks.md`](features/06-lifecycle-hooks.md)

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

## 7. `/anvil status`

📄 **Detailed plan:** [`features/07-status-command.md`](features/07-status-command.md)

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

**Risks:** Low. Mostly reads existing in-memory state.

---

## 8. Workflow composition (sub-workflows)

📄 **Detailed plan:** [`features/08-workflow-composition.md`](features/08-workflow-composition.md)

**Why:** Workflows cannot reuse other workflows. Composition would let common sequences
(setup, verify, release) be factored out and shared, reducing duplication as a project
accumulates workflows.

**Current state:** Each workflow is a flat, independent step list; no invocation of one
workflow from another.

**Design sketch:**
- Allow a step to invoke another discovered workflow as a sub-run, forwarding input (or
  named params from feature #5) and surfacing its summary as a step output (feature #3).
- Guard against cycles during discovery/validation.
- Decide how sub-run checkpoints nest in the append log so history/resume stay coherent.

**Files:** `src/types.ts`, `src/engine.ts`, `src/discovery.ts`, `src/validate.ts`,
`src/index.ts`, `README.md`, tests.

**Risks:** Higher complexity. Depends on features #3 (outputs) and ideally #5 (params)
to be worth doing. Cycle detection and checkpoint nesting need care. Recall the security
note in `README.md`: discovery imports workflow modules, so composition must not widen
the trust surface.

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

## Suggested sequencing

- **Land first, independently:** #1 (independent review) and #2 (history) — both are
  high value with contained surface area; #2 is nearly pure read-side.
- **Plan as a deliberate contract change:** #3 (step outputs), then #5 (params). These
  reshape `WorkflowContext`/`WorkflowDefinition` and unlock #8.
- **Quality-of-life, any time:** #4 (dry-run), #6 (hooks), #7 (status), #9 (budget).
- **After #3/#5:** #8 (composition), which depends on outputs and params to be useful.

Every contract change must keep the synchronized-update discipline in `AGENTS.md`:
`src/types.ts`, `src/validate.ts`, `src/engine.ts`, tests, `README.md`,
`skills/anvil-workflow-builder/SKILL.md`, and `examples/workflows/demo.ts`.
