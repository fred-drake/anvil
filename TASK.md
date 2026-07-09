# TASK.md — Review findings: forEach per-item fan-out (Feature 10)

Status after remediation. All resolved items verified by `npm run check` (206 tests) and
`npx vitest run --coverage` (branches 87.11% ≥ 85% threshold).

## 🔴 Critical Priority
- [x] **[BUG]** Per-item retry loop implemented. `executeForEachItem` now runs an inner
      retry loop that calls `resolveFailure`, so inside a `forEach` step `onFail` policies work:
      `goto` (self) retries the item with its own feedback, `maxLoops` is honored, `continue`
      abandons the item's remaining checks and moves on, and `onItemExhausted` fires on real
      exhaustion. `resolveFailure` gained an `itemIndex` param that builds item-qualified loop
      keys (`<checkId>-><stepId>#<itemIndex>`) and feedback keys (`<stepId>#<itemIndex>`), so
      `{loop}` and per-item `retryModelSelections` escalation now work. Resume seed is skipped
      for items (resume re-runs the fan-out fresh).
- [x] **[TESTING]** Coverage restored: branches 78.36% → 87.11% (≥ 85%). Added engine,
      validate, templating, and UI tests for the new paths.

## 🟠 High Priority
- [~] **[REFACTOR]** Drift fixed rather than doing the full `executeStepAttempt` extraction.
      The item path now has the safety the main loop has: `throwIfAborted` after subagent runs,
      after `waitForTurnComplete`, at the top of each attempt, and before each check; the
      "host cannot run subagents" message matches the main loop; subagent + checks re-applies
      model selection. Delegation dispatch is factored into `runItemDelegation`, shared by the
      item retry loop. The main loop and item loop remain separate functions **by design** —
      their retry control flow differs (outer `while (stepIndex)` vs. inner per-item loop) and
      their delegation-failure semantics differ (whole-step fail vs. item fail + `onItemExhausted`).
      Full unification is deferred as a lower-value, higher-risk follow-up.
- [x] **[VALIDATION]** Step-level and workflow-`defaults`-level `onFail.goto` are now rejected
      when they would leave a `forEach` step (previously only check-level was checked).
- [x] **[BUG]** `concurrency > 1` no longer silently no-ops: it emits a runtime `host.notify`
      warning that it degrades to sequential. Validation now also considers `defaults.delegation`
      (not just `step.delegation`) when rejecting `concurrency > 1` on non-subagent delegation.
      NOTE: the actual parallel worker pool is still unimplemented — deferred.

## 🟡 Medium Priority
- [x] **[BUG]** `outputFrom` + `forEach` is now a validation error (the step output is a digest).
- [x] **[BUG]** Step failure reason names the failing item and retry count
      (`forEach step "x" item 2/12 "src/bar.ts" failed after 3 retries: ...`).
- [x] **[TESTING]** Added the spec'd coverage: validate schema/goto-out/concurrency/outputFrom,
      templating (`{item}`/`{itemIndex}`/`{itemCount}` in prompts, shell-safe hostile-item
      injection into commands, `{loop}` per item, empty outside forEach), engine
      (`onItemExhausted: "continue"` records+proceeds / all-fail, per-item feedback isolation,
      per-item model escalation, empty-list notify + checkpoint, digest as output, `itemIndex`
      checkpoints, resume re-runs whole step, command JSON source + malformed JSON), UI counter.
- [x] **[UI]** `formatStepWidget` now shows the item counter on the running step.
- [x] **[DOCS]** README section (local-model pattern), `skills/anvil-workflow-builder/SKILL.md`
      guidance, and a new `examples/workflows/fan-out.ts`. Documented `{item}` empty outside
      forEach and that main-session delegation defeats context isolation.

## 🟢 Low Priority
- [x] **[DX]** `JSON.parse` of a command source's stdout is wrapped; malformed output fails with
      a message naming the step.
- [x] **[CLEANUP]** Removed unused imports (`Check`, `WorkflowStep` in `validate.ts`;
      `OnFailPolicy` in `engine.ts` — the latter was already unused on `master`).

## Deferred (not defects; follow-up work)
- Actual parallel fan-out (`concurrency > 1` worker pool). Sequential is the full local-model win.
- Full `executeStepAttempt` extraction unifying the main-loop and item execution paths.
