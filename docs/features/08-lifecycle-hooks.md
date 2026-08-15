# Feature 8 — Lifecycle hooks and completion notifications

Back to [Feature backlog](../FEATURE.md#8-lifecycle-hooks-and-completion-notifications).

## Summary

Let a workflow declare deterministic hooks that run at lifecycle points —
`onStepEnd`, `onComplete`, `onFail` — and optionally fire a push notification when a run
ends. This is the natural payoff of Anvil's "run without babysitting" design: a long
unattended run can commit, clean up, or notify when it finishes.

## Motivation

Anvil is built to run steps to completion without supervision, but nothing happens at the
boundaries: the engine emits checkpoints and posts a summary
(`postSummary`, `src/engine.ts:196`) and that's it. There is no author-controlled hook to
commit results, clean scratch files, or ping the user on completion or failure.

## Current state (grounding)

- The engine's `finish(state, failureReason)` (`src/engine.ts:171`) is the single funnel
  for every terminal outcome (`succeeded` / `failed` / `aborted`); it already restores
  model selection, emits the `run_end` checkpoint, sets status/widget, and posts the
  summary. This is the natural home for `onComplete` / `onFail`.
- Step completion funnels through `stepState.status = "passed"` + `step_pass` checkpoint
  (`src/engine.ts:387`) and the skipped/continued branches — a good anchor for
  `onStepEnd`.
- Command execution is centralized: `EngineHost.exec(command, args, options)`
  (`src/engine.ts:64`) → `pi.exec` (`src/index.ts:418`), and deterministic checks already
  run through it (`executeDeterministicCheck`, `src/gates.ts:88`). Shell quoting lives in
  `src/shell.ts` (`shellEscape`), per `AGENTS.md`.
- Notifications go through `host.notify` (`src/engine.ts:67`) → `ctx.ui.notify`. A richer
  push notification would use the harness `PushNotification` capability (out-of-band of
  the current host interface).

## Design

### Schema (`src/types.ts`)

Add a top-level `hooks` key to `WorkflowDefinition` — *not* under `defaults`. Every
existing `defaults` field (`onFail`, `maxLoops`) is a per-step-overridable setting;
lifecycle hooks are run-scoped and never overridden by a step, so nesting them under
`defaults` would misstate their semantics. A distinct
top-level key also avoids any confusion with `defaults.onFail`, which already exists as
an `OnFailPolicy` for *checks* (`src/types.ts:116`).

```ts
export interface WorkflowHook {
    /** Executed with bash -c; failures are surfaced but do not corrupt run state. */
    command: Templatable;
    cwd?: string;
    timeoutMs?: number;            // default e.g. 60_000
    /** When true, a non-zero exit marks the run failed (onComplete only). Default false. */
    required?: boolean;
}

export interface WorkflowDefinition {
    // ...existing...
    hooks?: {
        onStepEnd?: WorkflowHook;   // runs after each step reaches a terminal status
        onComplete?: WorkflowHook;  // runs when the run succeeds
        onFail?: WorkflowHook;      // runs when the run fails or aborts
        notifyOnComplete?: boolean; // fire a push notification at run_end
    };
}
```

A per-step `onStepEnd` override is conceivable but deferred; start workflow-level only.

### Hook context / templating

Hooks are `Templatable`, so they receive a `WorkflowContext`. For `onStepEnd`, the
context is the just-finished step's. For `onComplete` / `onFail` there is no "current
step", but `WorkflowContext.step` is required (`src/types.ts:4`) — define this
explicitly: build the context from the last step that ran (final `loopCounts`, and the
shipped `outputs`) and document that `step` refers to the last executed
step. Command templating reuses the safe placeholder machinery
(`renderCommandTemplatable`, `src/prompts.ts:26`).

### Engine wiring

- Add `runHook(hook, ctx, phase)` in the engine that renders the command and calls
  `host.exec("bash", ["-c", command], { cwd, timeout })`, mirroring
  `executeDeterministicCheck`. Wrap in try/catch: a hook throwing/exiting non-zero is
  reported via `host.notify(..., "warning")` and, unless `required`, does **not** change
  the run's terminal state.
- Call `onStepEnd` after each step settles (passed/continued/skipped) — a single call site
  just before `stepIndex += 1` at the natural terminal points.
- Call `onComplete` inside `finish("succeeded", ...)` and `onFail` inside
  `finish("failed" | "aborted", ...)` (`src/engine.ts:171`). Run hooks *before* the
  `run_end` checkpoint so their effect (e.g. a commit) is part of the recorded outcome, or
  after — pick one and document; running before lets a `required: true` `onComplete`
  failure flip the recorded `finalState` to `failed`.
- For `notifyOnComplete`, add an optional `host.pushNotification?(title, body)` method to
  `EngineHost` (`src/engine.ts:58`); implement it in `createEngineHost` (`src/index.ts:339`)
  using the harness push-notification capability. Keep it optional so hosts without it
  degrade to the existing `notify`.

### Validation (`src/validate.ts`)

- Add `"hooks"` to `WORKFLOW_KEYS` (`src/validate.ts:18`).
- `validateHooks`: an object whose keys are limited to `onStepEnd` / `onComplete` /
  `onFail` / `notifyOnComplete`; each hook is an object with a `Templatable` `command`,
  optional string `cwd`, optional positive-integer `timeoutMs`, optional boolean
  `required`; `notifyOnComplete` is a boolean. Reuse `isTemplatable` /
  `isPositiveInteger` (`src/validate.ts:334`/`:342`).

## Implementation steps

1. `src/types.ts`: `WorkflowHook`, top-level `hooks` (including `notifyOnComplete`).
2. `src/validate.ts`: extend `WORKFLOW_KEYS`; add `validateHooks`.
3. `src/engine.ts`: `runHook`; call sites at step settle and inside `finish`; optional
   `pushNotification` on `EngineHost`.
4. `src/index.ts`: implement `pushNotification` on the host.
5. Docs, skill, example, tests.

## Testing

- `test/engine.test.ts`: fake host records `exec` calls; assert `onStepEnd` runs per step
  with the right cwd/command; `onComplete` runs only on success; `onFail` runs on
  failure/abort; a failing non-required hook only warns; a failing `required: true`
  `onComplete` flips the recorded state (if that semantics is chosen).
- `test/validate.test.ts`: hook schema validation (missing command, bad timeout).
- Determinism: no real shell side effects; assert on the fake host's captured commands.

## Docs to update

- `src/types.ts` comments, `README.md` (hooks + notification), skill (interview for
  hooks), an example using `onComplete` to commit or notify.

## Risks & open questions

- **State corruption.** Hook failures must not silently break the run. Default to warn-only
  except opt-in `required`. Define ordering vs. the `run_end` checkpoint explicitly.
- **Naming collision** with the existing check-level `onFail` policy — use a distinct
  `hooks` namespace as above.
- **Shell safety.** Hooks run `bash -c`; route through centralized quoting per `AGENTS.md`.
- **Abort semantics.** On abort (`AnvilAbortError`), decide whether `onFail` still runs
  (recommended: yes, so cleanup happens) and keep it fast/bounded by `timeoutMs`.
- **Push notification availability** varies by harness; keep it optional and degrade to
  `notify`.
