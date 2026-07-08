# Feature 3 — Step outputs / data passing between steps

Back to [Feature backlog](../FEATURE.md#3-step-outputs--data-passing-between-steps).

## Summary

Give each step a captured textual output and expose prior outputs to later steps'
templates and checks via `ctx.outputs[stepId]`. This is the single biggest capability
unlock: it makes genuine multi-stage workflows (plan → implement → verify-against-plan)
possible without smuggling state through the filesystem.

## Motivation

`WorkflowContext` (`src/types.ts:1`) exposes only `input`, `step`, `loopCounts`, `cwd`.
A step cannot hand a value to a later step. The demo workflow already shows the pain: it
re-derives a filename from `ctx.input` with a regex in a later check
(`examples/workflows/demo.ts:29`) because there is no way to read what an earlier step
produced.

## Current state (grounding)

- Context is built per step by `makeWorkflowContext` (`src/engine.ts:577`) and passed to
  templating in `renderTemplatable` / `renderTemplateString` (`src/prompts.ts:21`/`:31`)
  and to command templating in `renderCommandTemplateString` (`src/prompts.ts:35`), which
  today only understands `{input}` and `{loop}`.
- Subagent steps already produce a textual result: `SubagentStepRunResult.summary`
  (`src/engine.ts:51`), returned from `runSubagentWithBackend` via
  `extractLastAssistantText` (`src/subagent/runner.ts:74`). The engine has this value in
  hand at `src/engine.ts:249` (`result`).
- Main-session steps do **not** currently capture a return value: the engine calls
  `host.sendInstruction` then `host.waitForTurnComplete` (`src/engine.ts:302`) with no
  text captured.
- Deterministic checks already produce `output` on their `GateResult`
  (`src/gates.ts:101`, field defined at `src/gates.ts:18`).

## Design

### Context shape (`src/types.ts`)

```ts
export interface WorkflowContext {
    input: string;
    step: { id: string; index: number };
    loopCounts: Record<string, number>;
    cwd: string;
    /** Captured textual outputs of prior steps, keyed by step id. */
    outputs: Record<string, string>;
}
```

Backward compatible: existing function-form templates that ignore `outputs` are
unaffected; string templates gain a new placeholder (below).

### Capture semantics (define precisely — this is the subtle part)

Per step, decide what "the output" is:

1. **Subagent-delegated step** (`delegation.mode === "subagent"`): capture
   `result.summary` (already available at `src/engine.ts:249`). This is the natural
   output — the child's final message is designed to be the step outcome
   (`buildSubagentStepTask`, `src/prompts.ts:138`).
2. **Main-session step** (`runInMain` or auto/skill executed in main): no return value is
   captured today. Options, in order of preference:
   - **(a) Explicit opt-in via a tool.** Register an `anvil_output` tool (sibling of
     `anvil_verdict`, `src/index.ts:311`) that the agent calls to record its output for
     the current step. The engine sets the active step id before `sendInstruction` and
     reads the recorded value after `waitForTurnComplete`. Clean and explicit, but relies
     on the agent calling it.
   - **(b) Last assistant text of the turn.** Requires host support to read the main
     session's last message; heavier and less predictable. Defer.
   - Recommendation: ship (a); document that `runInMain` steps only populate `outputs`
     when they call `anvil_output` (or when a deterministic capture check is used, below).
3. **Deterministic capture (optional).** Allow a step to designate that a named check's
   stdout becomes the step output, e.g. `outputFrom: "<checkId>"`, reading the
   `GateResult.output` already produced (`src/gates.ts:114`). Useful for "run a script,
   feed its stdout to the next step."

Store captures in an engine-local `outputs: Record<string, string>` map, spread into the
context by `makeWorkflowContext` (copy it like `loopCounts` is copied at
`src/engine.ts:587`, so a template function cannot mutate engine state). Apply size
limits (truncate with a documented cap, e.g. last 8 KB, reusing the `tail` helper
pattern from `src/gates.ts:225`).

**Retry loops overwrite.** When an `onFail: { goto }` policy re-runs a step, the new
attempt's capture replaces the previous one, so `{outputs.<id>}` always reflects the
latest attempt. State this explicitly and cover it in tests — it is the behavior a
"plan → implement → re-plan on failure" loop needs.

### Templating (`src/prompts.ts`)

- String prompts: add `{outputs.<stepId>}` expansion in `replaceTemplatePlaceholders`
  (`src/prompts.ts:42`). Unknown ids expand to empty string (document this) or a clearly
  marked `""`.
- Command templates: extend `renderCommandTemplateString` (`src/prompts.ts:35`) to inject
  `{outputs.<stepId>}` as shell variables using the same safe-quoting machinery as
  `{input}` (`renderCommandPlaceholders`, `src/prompts.ts:60`) — never raw interpolation,
  per `AGENTS.md`. Note `renderCommandPlaceholders` currently takes a *fixed* placeholder
  list; outputs need a pre-scan of the template for `{outputs.<id>}` tokens to build the
  placeholder list dynamically (one `__ANVIL_OUTPUT_<n>` variable per referenced id).
- Function-form templates get `ctx.outputs` for free.

### Ordering / resume interactions

- Outputs are only available from steps that already ran in this run. On `resume`
  (`resolveResumeState`, `src/engine.ts:402`), earlier steps are marked skipped and did
  **not** execute, so their outputs are absent. Document that `{outputs.x}` referencing a
  skipped-on-resume step yields empty; a workflow relying on it should resume from an
  earlier step. (A future enhancement could persist outputs to checkpoints for resume; out
  of scope here to keep the change contained.)

### Validation (`src/validate.ts`)

- If `outputFrom` is added to steps, add it to `STEP_KEYS` (`src/validate.ts:20`) and
  validate it references a check id that exists on that step.
- Optionally, statically warn when a string template references `{outputs.<id>}` for an id
  that is not a prior step — but templates can be functions, so keep this best-effort.

## Implementation steps

1. `src/types.ts`: add `outputs` to `WorkflowContext`; optional `outputFrom` on
   `WorkflowStep`.
2. `src/engine.ts`: maintain `outputs` map; capture subagent summary at
   `src/engine.ts:249`; spread into `makeWorkflowContext` (`src/engine.ts:577`); if
   `outputFrom`, capture the matching check's `GateResult.output` after checks run.
3. `src/index.ts`: register `anvil_output` tool; host stores/returns the recorded output
   for the current step (parallels `anvil_verdict`/`VerdictBus`).
4. `src/prompts.ts`: `{outputs.<id>}` in string + command templating.
5. `src/validate.ts`: `outputFrom` key + reference check.
6. Docs, skill, example (rework `examples/workflows/demo.ts` to consume a prior output
   instead of the regex).
7. Broad test updates.

## Testing

- `test/gates.test.ts` (where command-template rendering is covered today) or
  `test/engine.test.ts`: `{outputs.x}` renders in string and command templates with
  correct shell quoting; missing id → empty.
- `test/engine.test.ts`: subagent summary is captured into `outputs`; a later step's
  rendered prompt/command sees it; `outputFrom` captures deterministic stdout; resume
  leaves skipped-step outputs empty.
- Backward-compat: every existing workflow/test still passes with `outputs` present but
  unused.
- Determinism per `AGENTS.md`: fake host, no real subagents.

## Docs to update

- `src/types.ts` doc comments, `README.md` (new templating + capture semantics),
  `skills/anvil-workflow-builder/SKILL.md` (how to reference prior outputs),
  `examples/workflows/demo.ts`. This is the full synchronized-update set from `AGENTS.md`.

## Risks & open questions

- **Public-contract change.** Adding `outputs` to `WorkflowContext` touches the workflow
  contract; keep it additive and land it on its own (the backlog explicitly says to plan
  it separately).
- **Main-session capture reliability.** Option (a) depends on the agent calling
  `anvil_output`. Document the behavior and provide the deterministic `outputFrom` escape
  hatch for guaranteed capture.
- **Size / secrets.** Outputs may be large or sensitive; enforce truncation and note that
  outputs flow into later prompts and command env, so authors should not capture secrets.
- **Resume fidelity.** Outputs are in-memory per run. Persisting them for cross-run resume
  is a natural follow-up (store on `step_pass` checkpoints) but is deliberately out of
  scope to bound this change.
