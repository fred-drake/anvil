# Feature 2 — `/anvil history` and per-run reports

Back to [Feature backlog](../FEATURE.md#2-anvil-history-and-per-run-reports).

## Summary

Add `/anvil history [name]` to list recent runs and `/anvil report [runId]` to render a
detailed per-run report. Both read the checkpoint log Anvil already persists, so this is
almost entirely read-side presentation work.

## Motivation

Anvil already records everything needed but surfaces it only through `/anvil resume`.
Runs emit an append-only checkpoint stream via `host.checkpoint(...)`
(`src/engine.ts:160`) → `pi.appendEntry("anvil-run", entry)` (`src/index.ts:428`). Users
have no way to see what ran, how long it took, how many retries a step burned, or why a
run failed after the summary scrolls away.

## Current state (grounding)

- Checkpoint shape: `AnvilCheckpoint` (`src/engine.ts:121`) with `phase` in
  `run_start | step_start | check_result | step_pass | run_end`, plus `timestamp`,
  `runId`, `workflowName`, `input`, `stepId`, `stepIndex`, `checkId`, `pass`, `reason`,
  `loopCounts`, `finalState`.
- Reading logic already exists: `getSessionEntries` (`src/index.ts:593`),
  `toAnvilCheckpoint` (`src/index.ts:632`), and `findLatestResumableRun`
  (`src/index.ts:599`) which already folds a checkpoint stream into per-run state
  (`lastStartedStep`, `lastFailure`). `/anvil resume`'s `formatResumeStepMap`
  (`src/index.ts:640`) is the model for a Markdown report.
- Command dispatch lives in the `switch (subcommand)` in the `registerCommand("anvil")`
  handler (`src/index.ts:115`); the subcommand list for completions is the `subcommands`
  array in `getAnvilCompletions` (`src/index.ts:544`).
- Output is posted with `postCommandMessage(pi, customType, content)`
  (`src/index.ts:494`).

## Design

### New reader: fold checkpoints into per-run records

Add a pure function (new module `src/history.ts`, or exported from `index` internals so
it is unit-testable like `findLatestResumableRun`):

```ts
export interface RunHistoryEntry {
    runId: string;
    workflowName: string;
    input: string;
    startedAt?: string;         // run_start timestamp
    endedAt?: string;           // run_end timestamp
    durationMs?: number;        // endedAt - startedAt when both parse
    finalState?: "succeeded" | "failed" | "aborted";
    stepsStarted: number;
    lastStepIndex?: number;
    checksRun: number;
    checksFailed: number;
    failureReason?: string;
    loopTotals: Record<string, number>;  // last-seen loopCounts
}

export function buildRunHistory(entries: unknown[]): RunHistoryEntry[]; // chronological, oldest first
```

Reuse `toAnvilCheckpoint` for parsing. Fold by `runId` in a `Map`, mirroring the existing
`findLatestResumableRun` accumulation but retaining `run_start` for duration. Preserve
insertion order so runs sort by first-seen (oldest first); the renderer reverses to show
newest first.

### `/anvil history [name]`

- New `case "history":` in the handler switch calling `handleHistory(pi, ctx, rest)`.
- Fold `getSessionEntries(ctx)`; optionally filter by workflow name (`rest.trim()`).
- Render a Markdown table (formatter in `src/ui.ts`, next to `renderSummaryMarkdown`):
  run id, workflow, start time, duration, final state (✅/❌/⏹ like
  `renderSummaryMarkdown`, `src/ui.ts:47`), last step reached, checks passed/failed.
- Cap to the most recent N (e.g. 20) and note truncation, addressing the backlog's
  "watch for large append logs" risk.
- Empty case: `ctx.ui.notify("No Anvil runs recorded in this session.", "info")`.

### `/anvil report [runId]`

- New `case "report":` → `handleReport(pi, ctx, rest)`.
- Default to the most recent run when no id is given; otherwise match `runId` prefix.
- Render per-step detail: status, loop count, and each check with pass/fail + reason,
  reusing the `renderSummaryMarkdown` table style. Include start/end timestamps and total
  duration. Because `check_result` checkpoints carry `checkId`, `pass`, and `reason`, the
  report reconstructs per-check outcomes directly from the log.

### Completions

- Add `"history"` and `"report"` to the `subcommands` array (`src/index.ts:544`).
- For `history <name>` reuse the workflow-name completion branch already used by
  `run`/`validate` (`src/index.ts:554`). For `report <runId>`, offer recent run ids from
  the folded history (session-scoped; only if `ctx`/entries are reachable there — if not,
  leave run-id completion out initially).

## Implementation steps

1. Add `buildRunHistory` (+ `RunHistoryEntry`) in a new `src/history.ts`; export for
   tests via `__testing__` or direct import.
2. `src/ui.ts`: add `renderRunHistoryTable(entries, { limit })` and
   `renderRunReport(entry, checkpoints)`.
3. `src/index.ts`: add `handleHistory` / `handleReport`, wire into the switch, add
   subcommands to completions.
4. Tests + README.

## Testing

- `test/anvil-command.test.ts` style: feed synthetic checkpoint entry arrays into
  `buildRunHistory` and assert folding (duration from `run_start`→`run_end`,
  checksFailed counts, `finalState`, name filter).
- `test/ui.test.ts`: snapshot `renderRunHistoryTable` and `renderRunReport`, including the
  empty and truncated cases.
- `test/completions.test.ts`: `history`/`report` appear in subcommand completions and
  `history <prefix>` completes workflow names.

## Docs to update

- `README.md`: document `/anvil history` and `/anvil report` under Commands.
- No schema change, so `src/types.ts` / `examples` / skill are untouched.

## Risks & open questions

- **Log growth.** The session append log can be large; always cap the fold window and the
  rendered row count, and note truncation.
- **Session scope.** `getSessionEntries` reads the current session
  (`src/index.ts:593`). History is therefore session-scoped, matching how `/anvil resume`
  already behaves. Cross-session history would require a durable store and is out of
  scope; call this out in the README so expectations are clear.
- **Timestamp parsing.** Timestamps are ISO strings from `new Date().toISOString()`;
  duration math must tolerate missing/unparseable values (leave `durationMs` undefined).
