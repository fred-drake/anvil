# Feature 7 — `/anvil status`

Back to [Feature backlog](../FEATURE.md#7-anvil-status).

## Summary

Add `/anvil status` to report the currently running workflow (id, workflow name, current
step, retry count, elapsed) on demand, or state that nothing is running. This surfaces the
live progress that today exists only as an ambient status/widget.

## Motivation

A running workflow updates a status line and a step widget (`setStatus` / `setWidget`,
`src/engine.ts:194`/`:195`; formatters `formatStatus` / `formatStepWidget`,
`src/ui.ts:14`/`:36`), but there is no command to query progress on demand — for example
after scrolling away, reattaching to a mux session, or when the widget is not visible.

## Current state (grounding)

- Active-run state is tracked in the extension closure: `activeRun`
  (`src/index.ts:78`) of type `ActiveRun = { controller, runId }` (`src/index.ts:19`),
  set/cleared in `handleRun` / `handleResume` (`src/index.ts:132`, `:211`, etc.).
- The `abort` subcommand already reads `activeRun` directly in the handler switch
  (`src/index.ts:122`), so `status` has the same access.
- Per-step progress currently lives only in the engine's local `steps: StepRunState[]`
  (`src/engine.ts:151`) and the checkpoint stream; `ActiveRun` does not yet hold live step
  detail. The most recent checkpoints in the session log
  (`getSessionEntries` → `toAnvilCheckpoint`, `src/index.ts:593`/`:632`) reveal the last
  `step_start` (current step) and any recent `check_result`.

## Design

Two implementation options; recommend a hybrid.

1. **Minimal (in-memory only).** Report from `activeRun`: run id, plus workflow name and
   start time if we enrich `ActiveRun`. Enrich the `ActiveRun` type to carry
   `workflowName`, `input`, and `startedAt` (set where it is constructed in `handleRun` /
   `handleResume`). This gives run-level status with no dependency on the checkpoint log.

2. **Detailed (fold latest checkpoints).** For the *current step* and *retry count*, fold
   the session checkpoints for `activeRun.runId` — the last `step_start` gives the current
   `stepIndex`; `loopCounts` on the latest checkpoint gives retry progress. This reuses the
   same folding approach as `findLatestResumableRun` (`src/index.ts:599`) and the Feature 2
   `buildRunHistory` reader (share code if Feature 2 lands first).

**Recommended hybrid:** enrich `ActiveRun` for run-level fields (always accurate) and fold
recent checkpoints for step/retry detail (best-effort, may lag by one checkpoint).

### `/anvil status` → `handleStatus`

- If no `activeRun`: `ctx.ui.notify("No Anvil workflow is running.", "info")` (same phrasing
  as the `abort` no-run branch, `src/index.ts:124`).
- Otherwise render a short Markdown block via a `src/ui.ts` formatter
  (`renderRunStatus(...)`): workflow name, run id, current step `n/total` + title, retry
  count for that step, elapsed since `startedAt`. Post with `postCommandMessage`
  (`src/index.ts:494`).

### Completions

Add `"status"` to the `subcommands` array (`src/index.ts:544`). No argument completion
needed.

## Implementation steps

1. `src/index.ts`: extend `ActiveRun` (`src/index.ts:19`) with `workflowName`, `input`,
   `startedAt`; set these where `setActiveRun({...})` is called in `handleRun` /
   `handleResume`.
2. `src/ui.ts`: add `renderRunStatus(active, latestCheckpoints)`.
3. `src/index.ts`: add `handleStatus`; wire `case "status":` into the switch
   (`src/index.ts:115`); add `"status"` to subcommands.
4. Tests + README.

## Testing

- `test/anvil-command.test.ts`: `status` with no active run notifies "No Anvil workflow is
  running."; with an active run posts a status message containing the workflow name and run
  id. (Follow the existing command-test harness patterns.)
- `test/ui.test.ts`: `renderRunStatus` snapshot for a mid-run state (current step, retry
  count, elapsed) and a just-started state.
- `test/completions.test.ts`: `status` present in subcommand completions.
- Determinism: inject `startedAt` and a fixed "now" (or compute elapsed in the caller and
  pass it in) so the formatter test is stable — do not read the clock inside the formatter.

## Docs to update

- `README.md`: add `/anvil status` to Commands. No schema change; skip `types.ts` / skill /
  example.

## Risks & open questions

- **Staleness.** Checkpoint-derived step detail can lag the true engine state by one
  checkpoint. Run-level fields from the enriched `ActiveRun` are always current; document
  that step detail is best-effort.
- **Single active run.** Anvil enforces one active run per session (`handleRun` guards at
  `src/index.ts:157`), so `status` never has to disambiguate.
- **Elapsed-time source of truth.** Prefer computing elapsed from the enriched
  `ActiveRun.startedAt`; avoid clock reads inside pure formatters for testability.
- **Open question:** should `status` also echo the live step widget lines
  (`formatStepWidget`)? Those are engine-local and not currently exposed to the command
  layer; wiring them out would require the engine to publish `steps` to the host. Start
  with checkpoint-derived detail and consider promoting live `steps` later.
