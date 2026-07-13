# Feature 4 — `/anvil status`

Back to [Feature backlog](../FEATURE.md#4-anvil-status).

## Summary

Add `/anvil status` to report the currently running workflow (id, workflow name, current
step, retry count, elapsed) on demand, or state that nothing is running. This surfaces the
live progress that today exists only as an ambient status/widget.

## Motivation

A running workflow updates a status line and a step widget (`setStatus` / `setWidget`,
`src/engine.ts:194`/`:195`; formatters `formatStatus` / `formatStepWidget`,
`src/ui.ts:14`/`:36`), but there is no command to query progress on demand — for example
after scrolling away, reattaching to a mux session, or when the widget is not visible.

## Current state

- Active-run state is tracked in the extension closure with its controller, generated run
  ID, start time, and latest `RunProgressSnapshot`.
- The `abort` and `status` subcommands read that state directly in the command switch.
- The engine publishes progress from its active validated workflow and reconciled step state;
  editable session checkpoints are not a status input.

## Design

Use in-memory state end to end. The host reserves a safe loading state with only the generated
run ID and start time. Once validation succeeds, it stores initial workflow metadata. During
execution, the engine publishes immutable snapshots containing the active workflow name,
step IDs/titles, current step index, and retry count. Publishing after accepted watch reload
reconciliation prevents stale definition metadata from reaching status.

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

## Implementation

1. `src/engine.ts` publishes immutable `RunProgressSnapshot` values from the authoritative
   active workflow definition and centralized step UI updates. Accepted watch reloads publish
   their reconciled workflow name, step IDs/titles, current index, total, and retry count.
2. `src/index.ts` keeps the generated run ID, start time, and latest engine snapshot in
   `ActiveRun`. The loading reservation never includes user-supplied workflow or task text.
3. `src/ui.ts` renders deterministic elapsed time and bounded progress, with final-boundary
   redaction and Markdown neutralization for every displayed text field.
4. `src/index.ts` wires `case "status":` into the switch and adds `"status"` to subcommands.

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

## Runtime properties

- **Authoritative progress.** Status does not fold editable session checkpoints. Engine
  snapshots update from the accepted active definition, including watch-mode reconciliation.
- **Single active run.** Anvil enforces one active run per session, so `status` never has to
  disambiguate.
- **Elapsed-time source of truth.** Elapsed time is computed from in-memory
  `ActiveRun.startedAt`; the pure formatter does not read the clock.
- **Read-only boundary.** Status reads only active in-memory state and posts UI output. It
  does not execute commands, launch agents, append entries, or inspect filesystem paths.
