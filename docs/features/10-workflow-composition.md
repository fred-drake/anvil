# Feature 10 — Workflow composition (sub-workflows)

Back to [Feature backlog](../FEATURE.md#10-workflow-composition-sub-workflows).

## Summary

Let a step invoke another discovered workflow as a sub-run, forwarding input (or named
params from Feature 6) and surfacing the sub-run's outcome as a step output (the shipped
step outputs). This lets common sequences (setup, verify, release) be factored out and
reused.

## Motivation

Each workflow is a flat, independent step list today; there is no way to reuse another
workflow. As a project accumulates workflows, shared sequences get copy-pasted. Composition
removes that duplication and lets small, well-tested workflows become building blocks.

## Dependencies

- **Step outputs (shipped)** — a sub-run's result is only useful if the parent can read
  it; that is exactly `ctx.outputs`.
- **Feature 6 (named params)** — forwarding structured values into a sub-workflow is far
  cleaner than concatenating strings. Composition is worth building *after* params lands.

## Current state (grounding)

- Discovery already loads and validates every workflow: `discoverWorkflows`
  (`src/discovery.ts:34`) returns `DiscoveredWorkflow[]`; `findWorkflow(cwd, name)`
  (`src/index.ts:489`) resolves one by name. Project workflows shadow user ones by name
  (`src/discovery.ts:45`).
- The engine's public entry is `runWorkflow(options)` (`src/engine.ts:143`) taking a fully
  validated `WorkflowDefinition`, a `host`, `input`, `cwd`, `runId`, and optional
  `resume`/`signal`. A sub-run is "call `runWorkflow` again with the same host and a child
  run id."
- Checkpoints are keyed by `runId` (`src/engine.ts:160`); nesting sub-runs naively would
  interleave two runs' checkpoints in one session log, which `findLatestResumableRun`
  (`src/index.ts:599`) and Feature 2's reader fold by `runId`.
- The security note in `README.md` warns that discovery imports workflow modules and runs
  their top-level code; composition must not widen that trust surface.

## Design

### Schema (`src/types.ts`)

Introduce a step that runs a sub-workflow instead of a prompt. Prefer a discriminated
addition over overloading `prompt`:

```ts
export interface WorkflowStep {
    id: string;
    title?: string;
    // Exactly one of `prompt` or `uses` describes the work:
    prompt?: Templatable;
    /** Run another discovered workflow as this step. */
    uses?: {
        workflow: string;               // sub-workflow name (project shadows user)
        input?: Templatable;            // defaults to parent's {input}
        params?: Record<string, Templatable>;  // when Feature 6 is present
        /** Cap sub-run loop budget etc. Inherit parent defaults if omitted. */
    };
    // ...existing fields (checks still gate the sub-run's result)...
}
```

Validation must enforce exactly one of `prompt` / `uses`.

### Engine wiring

- When a step has `uses`, the engine resolves the sub-workflow (a resolver injected into
  `RunWorkflowOptions`, so the engine stays free of filesystem/discovery concerns and
  tests can fake it) and calls `runWorkflow` with:
  - a **child run id** derived from the parent (e.g. `${runId}.sub<n>`),
  - the rendered `input` / `params`,
  - a **wrapped host** (see below),
  - the parent `signal` (so abort propagates).
- **Wrap the host — do not pass it through raw.** The child run's own lifecycle calls
  would otherwise fight the parent's: its `finish` posts a full `RunSummary` message
  (`postSummary`, `src/engine.ts:196`) and sets terminal status/widget state
  (`setStatus`/`setWidget`), which would interleave a "done/failed" summary mid-parent-run
  and clobber the parent's step widget. The sub-run wrapper should:
  - pass `exec`, `sendInstruction`, `waitForTurnComplete`, `awaitVerdict`, and `notify`
    through unchanged,
  - pass `checkpoint` through with `parentRunId` stamped (see below),
  - suppress or prefix `setStatus`/`setWidget` (the parent's step UI already shows the
    `uses` step as running),
  - swallow `postSummary` and instead hand the child's `RunSummary` back to the parent
    engine, which records it as the step's captured output.
- The sub-run's `RunSummary` (`src/engine.ts:107`) becomes the step's captured output
  (the shipped step outputs): use `summary.failureReason` or a rendered digest. A failed
  sub-run fails the
  parent step, then its normal `onFail` policy applies.

### Checkpoint nesting

Add a `parentRunId` (and/or `depth`) field to `AnvilCheckpoint` (`src/engine.ts:121`) so
folding logic can attribute sub-run checkpoints to their parent. Update
`findLatestResumableRun` and Feature 2's `buildRunHistory` to treat child runs as nested
rather than as separate top-level runs. Decide resume semantics: resuming a parent that
contains a `uses` step re-runs the whole sub-workflow (simplest, recommended) rather than
resuming into the middle of a sub-run.

### Cycle detection

- Detect cycles during validation/resolution: maintain the chain of workflow names being
  entered; if `uses.workflow` is already on the stack, fail with a clear
  "workflow cycle: a → b → a" error. Do this both statically (best-effort, at
  discovery/validate when the graph is resolvable) and defensively at runtime (authoritative,
  since a name can resolve differently by scope).
- Bound nesting depth as a backstop (e.g. max depth 10) with an explicit error.

### Validation (`src/validate.ts`)

- Add `"uses"` to `STEP_KEYS` (`src/validate.ts:20`); require exactly one of
  `prompt`/`uses`; validate `uses.workflow` is a non-empty string and, when resolvable,
  exists; validate `params` keys against the sub-workflow's declared params (Feature 6).
- Cross-workflow existence/cycle checks may need a discovery-aware validation pass, since
  `validateWorkflow` (`src/validate.ts:41`) is currently pure/single-workflow. Consider a
  separate `validateWorkflowGraph(discovered[])` step invoked by `handleValidate` /
  `handleRun` rather than bloating the pure validator.

## Implementation steps

1. Land Features 3 and 5 first.
2. `src/types.ts`: add `uses` to `WorkflowStep`; make `prompt` optional with the
   one-of-two rule.
3. `src/validate.ts`: `uses` key + one-of rule; add graph validation
   (`validateWorkflowGraph`) for existence + cycles + param compatibility.
4. `src/engine.ts`: sub-run execution path; child run ids; capture sub-run summary as
   output; `parentRunId` on checkpoints; depth guard.
5. `src/index.ts`: inject a workflow resolver (wrapping `findWorkflow`) into
   `runWorkflow`; update folding readers to nest child runs.
6. Docs, skill, example; tests.

## Testing

- `test/engine.test.ts`: a `uses` step runs a fake sub-workflow via an injected resolver;
  its summary lands in `ctx.outputs`; a failing sub-run fails the parent step and triggers
  `onFail`; abort propagates to the sub-run.
- `test/validate.test.ts`: one-of `prompt`/`uses`; cycle detection (`a→b→a`); depth cap;
  param mismatch.
- Folding tests: child-run checkpoints nest under the parent in history/resume.
- Determinism: inject the resolver; never touch the real filesystem for sub-workflow
  resolution in unit tests.

## Docs to update

Full synchronized set per `AGENTS.md`, plus a `README.md` note that composition respects
the same trust model (discovery imports modules) and does not broaden it.

## Risks & open questions

- **Complexity** is the highest in this backlog; sequence it last.
- **Trust surface.** Sub-workflows are still discovered modules whose top-level code runs;
  document that composition does not change the "trusted projects only" posture from
  `README.md`.
- **Checkpoint/resume coherence.** Nesting must not confuse the existing resumable-run
  folding. Prefer whole-sub-run re-execution on resume to avoid deep resume state.
- **Cycle + depth safety** must be authoritative at runtime because name resolution is
  scope-dependent (project shadows user).
- **Open question:** should sub-runs get an isolated `runId` space in the UI/widget, or
  render inline as parent steps? Inline is simpler for users; nested attribution matters
  mainly for history.
