# Feature 3 — Mid-run reload and id-based resume

Back to [Feature backlog](../FEATURE.md#3-mid-run-reload-and-id-based-resume).

## Summary

Make a workflow's position durable by **step id** rather than numeric index, then use
that foundation to let a run pick up an edited definition. Two phases:

- **Phase 1 (priority): id-based resume.** Resume matches the resume point to a step id
  and rehydrates already-captured step outputs, so editing a workflow between a failed run
  and its resume is safe and lossless.
- **Phase 2 (dev-mode): reload while running.** An opt-in mode re-imports and re-validates
  the workflow at each step boundary, so you can tune a workflow live — "train as you use
  it" — without aborting the run.

## Motivation

Anvil already persists everything needed and already re-reads workflow files fresh from
disk on every run/resume. What is missing is a reconciliation layer: the run's *position*
is tracked by index while all its *durable state* is keyed by id, and nothing bridges the
two. That split makes resume silently wrong across edits and makes live reload impossible.

Now that [step outputs](shipped-step-outputs.md) has shipped, the second half of
the gap has teeth: a resumed run discards every prior step's captured output, which is now
real workflow state that later steps template against.

## Current state (grounding)

- **The loader is already reload-friendly.** `loadWorkflowFile` builds jiti with
  `moduleCache: false, fsCache: false` (`src/discovery.ts:54-60`), so each import
  re-evaluates the file from disk, bypassing Node's ESM cache. Every run/resume/validate
  path discovers with `useCache: false` (`src/index.ts` `findWorkflow`, `handleList`,
  `handleValidate`), and a mtime+size directory signature already exists
  (`workflowDirSignature`, `src/discovery.ts:88-109`). No new re-import primitive is
  needed.
- **The engine captures the definition once.** `runWorkflow` (`src/engine.ts:155`) closes
  over `options.workflow` and reads `options.workflow.steps[stepIndex]` at the top of the
  loop (`src/engine.ts:221-223`) but never re-fetches it.
- **Position is index-addressed; state is id-keyed.** The loop advances `stepIndex`
  (`src/engine.ts:220-224`); the parallel `steps: StepRunState[]` array is built once
  (`src/engine.ts:164-170`) and indexed in lockstep. Meanwhile `loopCounts`, `outputs`,
  `feedbackByStep`, checkpoint `stepId`, runtime check ids
  (`makeRuntimeCheckId` → `runId:stepId:checkIndex:attempt`), and `onFail.goto`
  (`findIndex(s => s.id === policy.goto)`, `src/engine.ts:537`) are all keyed by
  `step.id`.
- **Resume trusts the index.** `handleResume` (`src/index.ts:221`) folds checkpoints in
  `findLatestResumableRun` (`src/index.ts:664-695`), tracking only the max `step_start`
  `stepIndex` — it never matches a checkpoint back to a step id. `resolveResumeState`
  (`src/engine.ts:493-518`) sets `startIndex = stepNumber - 1`, marks earlier steps
  skipped, and seeds `loopCounts["resume->" + step.id] = retryCount`. Crucially,
  `outputs` and `feedbackByStep` start **empty** on resume (`src/engine.ts:158-160`); only
  that one seeded loop count survives.
- **No file-watch / reload machinery exists** anywhere in `src/` beyond the jiti loader.

## Design

### Phase 1 — id-based resume

1. **Resolve the resume target by id.** In `findLatestResumableRun`, keep the last
   `step_start`'s `stepId` alongside its index. In the resume UI (`formatResumeStepMap`,
   `src/index.ts:705`) continue to accept a positional `/anvil resume <n>` for
   back-compat, but resolve the seeded position by locating that id in the *current*
   on-disk definition. When the id is absent (renamed/removed), surface a clear error and
   list the current steps rather than silently landing on the wrong index.
2. **Rebuild `StepRunState[]` by id.** In `resolveResumeState`, construct the state array
   from the current definition, carrying `status: "skipped"` / `loops` forward for ids
   that appear in the checkpoint history and `"pending"` for genuinely new ids, instead of
   assuming positional alignment.
3. **Rehydrate prior outputs (and optionally feedback).** Fold the checkpoint stream to
   recover `outputs[stepId]` for completed steps, reusing Feature 2's `buildRunHistory`
   reader (share the fold; do not duplicate it). This requires that the captured output be
   recoverable from checkpoints — if it is not already recorded, add it to the
   `step_pass` checkpoint payload (bounded by the existing 8 KiB truncation) or document
   that rehydration is best-effort.
4. **Back-compat:** a workflow that was never edited between runs must resume exactly as
   today.

### Phase 2 — dev-mode reload

1. **Opt-in only.** Gate behind an explicit `/anvil run --watch <name>` flag (or a
   `reloadBetweenSteps` dev flag), never on by default. Anvil's contract is deterministic,
   unattended runs; live editing deliberately breaks reproducibility, so it stays a
   dev-facing mode.
2. **Reload at the loop head only.** At the top of the `while` loop (`src/engine.ts:221`),
   before the next `step` is read, re-run discovery (guarded by the mtime signature so the
   common case is a cheap no-op), re-run `validateWorkflow`, and swap `options.workflow`
   **only if valid**. On a broken or mid-edit file, keep the previous definition and emit
   a warning via `host.notify`. Never reload mid-step or mid-`forEach` item, where `step`
   is bound in inner scopes.
3. **Reconcile after a swap.** Re-locate the current position by the id of the step about
   to run (reusing Phase 1's id matching), rebuild `StepRunState[]` by id, and revalidate
   `onFail.goto` targets against the new definition so a dangling goto fails loudly rather
   than mid-run.
4. **Keep history coherent.** Stamp a definition-version marker (e.g. a hash of the step
   ids/order, or a monotonically increasing reload counter) into each checkpoint so
   `/anvil history` (#2) and later resume can tell that the definition changed mid-run.

## Files

- `src/engine.ts` — id-based `resolveResumeState`, rebuild-`StepRunState`-by-id helper,
  the reload hook at the loop head, goto revalidation.
- `src/index.ts` — resume matching by id, output rehydration shared with #2's reader,
  `run`/`resume` arg + `--watch` flag parsing and completions.
- `src/discovery.ts` — a small re-discovery helper keyed by the existing mtime signature.
- `src/validate.ts` — reuse for mid-run re-validation.
- `src/types.ts` — only if a dev flag is surfaced on `WorkflowDefinition`.
- `test/engine.test.ts`, `test/anvil-command.test.ts` — resume-across-edit cases, output
  rehydration, reload-swaps-only-when-valid, goto revalidation.
- `README.md`, `skills/anvil-workflow-builder/SKILL.md` — document id-based resume and the
  opt-in reload mode.

## Risks

- **Resume/replay contract.** Phase 1 changes how the resume point is derived. It must
  stay backward compatible with positional `/anvil resume <n>` while adding id matching,
  and rehydration must not resurrect stale outputs for steps that will re-run.
- **Determinism tension.** Phase 2 means a run is no longer defined by
  (workflow file + input). Keep it strictly opt-in and dev-facing; document the tradeoff.
- **Safety of a bad swap.** A reload of a syntactically broken or invalid file must never
  corrupt a live run — always fall back to the last good definition and warn.
- **Sequencing.** Land after [Feature 2](02-history-and-run-reports.md): its
  checkpoint-folding reader is the natural substrate for both id matching and output
  rehydration. Consider landing Phase 1 alone first; it is valuable on its own and is the
  prerequisite for Phase 2.

## Open questions

- Should captured step output be added to the `step_pass` checkpoint so resume can
  rehydrate it, or is best-effort rehydration (only what checkpoints already carry)
  acceptable for v1?
- For `--watch`, is polling on the existing mtime signature at each step boundary
  sufficient, or is an `fs.watch` subscription worth the added surface?
- How should a mid-run reload that *removes* the currently running step behave — abort
  with a clear terminal state, or skip forward to the next surviving step?
