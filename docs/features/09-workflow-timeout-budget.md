# Feature 9 — Whole-workflow timeout / budget

Back to [Feature backlog](../FEATURE.md#9-whole-workflow-timeout--budget).

## Summary

Add an optional workflow-wide ceiling — a max wall-clock duration and/or a total-retry
budget — that hard-stops a run. Individual steps and checks already have timeouts, but a
run can loop for a long time within its per-check `maxLoops` budgets; a global limit gives
unattended runs a guaranteed stop.

## Motivation

Timeouts today are local: `DeterministicCheck.timeoutMs` and `AgentCheck.timeoutMs`
(default 300_000). Retry loops are bounded per check by `maxLoops`
(`resolveFailure`, `src/engine.ts:451`), but a workflow with several looping checks can
still run far longer than intended. There is no single knob that says "never run longer
than N minutes / M total retries."

## Current state (grounding)

- The run loop is a `while (stepIndex < steps.length)` in `runWorkflow`
  (`src/engine.ts:208`) with `throwIfAborted(options.signal)` checks at the top of each
  iteration and around each check (`src/engine.ts:209`, `:320`).
- All terminal outcomes funnel through `finish(state, failureReason)`
  (`src/engine.ts:171`), and the catch block already maps aborts vs. failures
  (`src/engine.ts:394`): `options.signal?.aborted || isAnvilAbortError(error)` →
  `finish("aborted", ...)`.
- `startedAt` is captured at run start (`src/engine.ts:145`), so elapsed time is available.
- Retry counts accumulate in `loopCounts` (`src/engine.ts:146`, updated in `resolveFailure`,
  `src/engine.ts:449`), so a total-retry budget is a sum over that map.

## Design

### Schema (`src/types.ts`)

```ts
export interface WorkflowDefinition {
    // ...existing...
    limits?: {
        /** Hard wall-clock ceiling for the whole run, in ms. */
        maxDurationMs?: number;
        /** Optional cap on total retries (sum of goto loops) across the run. */
        maxTotalRetries?: number;
    };
}
```

Both optional; absent means unlimited (today's behavior). A top-level `limits` key is
preferred over `defaults` because every existing `defaults` field is a
per-step-overridable setting, while these are run-scoped ceilings nothing can override
(the same reasoning as Feature 8's top-level `hooks`).

### Enforcement (`src/engine.ts`)

- **Duration.** Compute `deadline = Date.parse(startedAt) + maxDurationMs`. Two layers:
  1. A cooperative check at the top of the run loop (`src/engine.ts:208`) and before each
     check (near `src/engine.ts:320`): if `Date.now() > deadline`, stop the run.
  2. A timer that aborts the run's `AbortController` at the deadline, so an ordinary
     harness turn blocked inside `waitForTurnComplete` or a long `exec` is interrupted too.
     The engine does not own the controller (the host does, `src/index.ts:168`), so add an
     internal `AbortController` in `runWorkflow` combined with `options.signal` (mirror the
     `combineAbortSignals` pattern already used in `src/gates.ts:191`), and abort it on the
     timer. This guarantees the ceiling even mid-step.
- **Total retries.** In `resolveFailure` (`src/engine.ts:429`), after incrementing the loop
  counter, compare the sum of `loopCounts` (goto entries) against `maxTotalRetries`; when
  exceeded, return a `stop` decision with a distinct reason.
- **Distinct terminal reason.** A duration/budget stop should be reported as a failure with
  a clear reason (e.g. `"workflow exceeded maxDurationMs (600000)"`), not a generic abort,
  so history and the summary explain *why* it stopped. Two mechanisms are needed, not one:
  - **Cooperative checks** throw a dedicated `AnvilTimeoutError` (new subclass in
    `src/errors.ts`, alongside `AnvilAbortError`) which the catch maps to
    `finish("failed", reason)`.
  - **A `timedOut` flag**, set just before the deadline timer aborts the internal
    controller. This is not optional: a step blocked in `waitForTurnComplete` or `exec`
    rejects with `AnvilAbortError` when the combined signal fires (the abort listeners
    throw it, e.g. `src/index.ts:728`), and the existing catch
    (`src/engine.ts:395`) would classify that as `"aborted"` via `isAnvilAbortError`.
    The catch must branch on the flag *before* the abort classification.

### Validation (`src/validate.ts`)

- Add `"limits"` to `WORKFLOW_KEYS` (`src/validate.ts:18`); restrict its keys to
  `maxDurationMs` / `maxTotalRetries`.
- Validate both as positive integers (`isPositiveInteger`, `src/validate.ts:342`).

## Implementation steps

1. `src/types.ts`: add top-level `limits` with `maxDurationMs` / `maxTotalRetries`.
2. `src/errors.ts`: add `AnvilTimeoutError` + an `isAnvilTimeoutError` guard.
3. `src/engine.ts`: internal combined `AbortController`; deadline timer setting a
   `timedOut` flag before aborting; cooperative checks throwing `AnvilTimeoutError`;
   total-retry check in `resolveFailure`; catch branches on `AnvilTimeoutError` or the
   flag (before the abort classification) to a failed finish with the reason; clear the
   timer in `finish`.
4. `src/validate.ts`: extend `DEFAULTS_KEYS`; validate the new fields.
5. Docs, skill; tests.

## Testing

- `test/engine.test.ts`:
  - `maxTotalRetries` — a workflow that would otherwise loop within per-check `maxLoops`
    stops once the summed retry budget is exceeded, with the documented reason and a
    `failed` state.
  - `maxDurationMs` — using a fake clock / injected `now` and a fake host whose step
    "hangs" until aborted, assert the run ends `failed` with the timeout reason and that
    the internal controller aborted the pending step. (Inject the time source rather than
    reading `Date.now()` directly so the test is deterministic, per `AGENTS.md`.)
  - The `run_end` checkpoint records the timeout reason so Feature 2 history reflects it.
- `test/validate.test.ts`: positive-integer validation for both fields.

## Docs to update

- `src/types.ts` comments, `README.md` (document the ceiling and that it reports as a
  failure, not a silent stop), `skills/anvil-workflow-builder/SKILL.md` (offer the budget
  when interviewing).

## Risks & open questions

- **Interrupting mid-step.** The cooperative check alone cannot stop a step already
  blocked in a harness turn or command; the internal-controller timer is what makes the
  ceiling real. Ensure the timer is always cleared in `finish` to avoid leaks.
- **Abort vs. timeout semantics.** Do not let a timeout be misclassified as a user abort
  (which reports `"aborted"` and produces no status, `src/ui.ts:17`). The dedicated error
  covers cooperative checks, but only the `timedOut` flag covers deadline aborts that
  surface as `AnvilAbortError` from blocked waits — test both paths.
- **Injected time source.** For testability, thread a `now()` function (or accept it on
  `RunWorkflowOptions`) instead of calling `Date.now()` inline; the engine already avoids
  hidden nondeterminism elsewhere.
- **Open question:** should `maxTotalRetries` count only `goto` loops or other retry
  sources? Start with `goto` loop counts (what `loopCounts` tracks) and document the
  scope.
