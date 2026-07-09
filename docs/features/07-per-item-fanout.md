# Feature 7 — Per-item fan-out (`forEach` steps)

Back to [Feature backlog](../FEATURE.md#7-per-item-fan-out-foreach-steps).

## Summary

Let a step declare a list of items and have the **engine** run the step's prompt once
per item, each in a fresh subagent session, with `{item}` available to the prompt and
checks. This moves work decomposition out of the model and into a deterministic loop,
which is the key unlock for small-context local models: each subagent gets one small,
self-contained task ("write test stubs for `{item}`") instead of one monolithic task
("write test stubs for the feature").

## Motivation

A step today is one prompt executed by one agent session. For a feature-sized task on a
frontier model that is fine; on a small local model (e.g. qwen3.6-27B) a step like
"write unit test stubs for this feature" exceeds what the model can hold and plan at
once. Prompting the model itself to "spawn subagents per file" hands orchestration to
the least reliable component in the system — a 27B model will do that dance correctly
sometimes and choke other times, while a loop in `src/engine.ts` does it correctly every
time.

Per-item fan-out also makes retries dramatically more effective: `onFail` feedback
becomes "this one file failed for this reason" instead of "somewhere in the feature,
something is wrong," and `retryModelSelections` escalation applies per item, so one
stubborn file can escalate to a stronger model while the rest stay cheap.

## Dependencies

- **Step outputs (shipped)** — the natural item source is a prior enumeration step's
  captured output (`(ctx) => JSON.parse(ctx.outputs["plan"]).files`). The command item
  source (below) keeps `forEach` usable without it.
- Independent of Features 6/10. `forEach` is data-driven repetition of one step;
  Feature 10's `uses` is reuse of a workflow. A later enhancement may allow combining
  them ("run sub-workflow per item"), but that is explicitly out of scope here.

## Current state (grounding)

- The run loop executes exactly one prompt per step: delegation resolves at
  `src/engine.ts:225`, a subagent step runs once via `host.runSubagent`
  (`src/engine.ts:249`), a main-session step sends one instruction
  (`src/engine.ts:302`), then checks run in a loop (`src/engine.ts:319`).
- Retry state is keyed per step, not per item: loop counts use
  `"<checkId>-><stepId>"` keys (`src/engine.ts:447`), feedback is stored in
  `feedbackByStep` keyed by step id (`src/engine.ts:461`, consumed at
  `src/engine.ts:241`), and `getCurrentLoopCount` suffix-matches `-><stepId>`
  (`src/prompts.ts:246`).
- Templating knows only `{input}` and `{loop}` (`src/prompts.ts:42` for prompts,
  `src/prompts.ts:35`/`:60` for shell-safe command templating).
- The engine already has `host.exec` (`src/engine.ts:64`) — a deterministic command
  item source needs no new host capability.
- The cmux runner already supports multiple concurrent surfaces via
  `createCmuxSubagentRunner` / `createSurfaceManager` (`src/subagent/runner.ts:120`),
  so bounded parallel fan-out has infrastructure to build on. Each subagent run is
  already a fresh session with its own session/task files
  (`runSubagentWithBackend`, `src/subagent/runner.ts:151`).
- `AnvilCheckpoint` (`src/engine.ts:121`) has no item fields; `formatStatus` /
  `formatStepWidget` (`src/ui.ts`) render step/check progress only.

## Design

### Schema (`src/types.ts`)

```ts
export type ForEachItemSource =
	| ((ctx: WorkflowContext) => string[] | Promise<string[]>)
	| {
			/** Executed with the same shell-safe templating as deterministic checks. */
			command: Templatable;
			/** How to turn stdout into items. Defaults to "lines" (non-empty, trimmed). */
			parse?: "lines" | "json";
	  };

export interface WorkflowForEach {
	items: ForEachItemSource;
	/** Max concurrent item sessions. Defaults to 1 (sequential; local-model friendly). */
	concurrency?: number;
	/** Safety cap on enumeration. Defaults to 100; exceeding it fails the step. */
	maxItems?: number;
	/** After an item exhausts its retries: fail the step ("stop", default) or record and move on ("continue"). */
	onItemExhausted?: "stop" | "continue";
}

export interface WorkflowStep {
	// ...existing fields...
	/** Run this step's prompt once per item. */
	forEach?: WorkflowForEach;
}
```

Items are **strings** in v1. A function source returning anything other than an array
of strings fails the step with a clear reason (do not coerce). Authors who need
structured items can `JSON.stringify` each one and say so in the prompt.

`WorkflowContext` gains optional item fields (additive, like the shipped `outputs`):

```ts
export interface WorkflowContext {
	// ...existing fields...
	/** Present only inside a forEach step. */
	item?: string;
	itemIndex?: number;
	itemCount?: number;
}
```

### Item sources

1. **Function form** — `(ctx) => JSON.parse(ctx.outputs["research-and-plan"]).files`.
   Runs in-process; pairs naturally with the shipped step outputs. A throw fails the step
   with the error message as the reason.
2. **Command form** — `{ command: "git diff --name-only master", parse: "lines" }`.
   Rendered through `renderCommandTemplatable` (never raw interpolation, per
   `AGENTS.md`), executed via `host.exec` like deterministic checks
   (`executeDeterministicCheck`, `src/gates.ts`). Non-zero exit fails the step.
   `parse: "json"` requires stdout to be a JSON array of strings.

The command form is the recommended pattern for local models: a prior plan step is
gated by a deterministic check that its emitted file list parses, then `forEach`
enumerates it mechanically — no model judgment in the decomposition path.

**Empty list:** the step passes trivially with a `host.notify` info message and a
`step_pass` checkpoint reason of `"forEach: 0 items"`. Workflows that consider empty
enumeration an error should gate the enumeration step itself.

**`skipIf`** is evaluated once for the whole step, before enumeration (unchanged
position in the run loop, `src/engine.ts:214`).

### Templating (`src/prompts.ts`)

- String prompts and agent-check prompts: add `{item}`, `{itemIndex}` (zero-based) and
  `{itemCount}` to `replaceTemplatePlaceholders` (`src/prompts.ts:42`). Outside a
  `forEach` step these expand to empty string / are absent from `ctx` (document this).
- Command templates: extend the placeholder list in `renderCommandTemplateString`
  (`src/prompts.ts:35`) with `{item}` → `__ANVIL_ITEM` etc., reusing the existing
  shell-safe machinery in `renderCommandPlaceholders` (`src/prompts.ts:60`).
- `{loop}` inside a `forEach` step means the **current item's** retry count (see
  per-item retry keys below), which keeps its meaning consistent for feedback loops.
- Function-form templates get `ctx.item` / `ctx.itemIndex` / `ctx.itemCount` for free.

### Execution semantics (`src/engine.ts`)

Refactor first: extract the body of the run loop that executes one unit of work —
build instruction → delegate (subagent or main) → run checks → resolve failure —
into a helper (`executeStepAttempt`) that takes a `WorkflowContext`. The existing
single-prompt path calls it once; the `forEach` path calls it per item. This refactor
is the bulk of the change and should be a pure-move commit before behavior changes.

Per item, the engine:

1. Builds the context via `makeWorkflowContext` (`src/engine.ts:577`) with
   `item`/`itemIndex`/`itemCount` set.
2. Executes the prompt through the step's resolved delegation. Subagent delegation is
   the intended mode (fresh session per item — context never accumulates across
   items). Main-session and skill delegation still work but run items as sequential
   instructions in the main session; document that this defeats the context-isolation
   purpose for local models.
3. Runs the step's checks with the same item context, so
   `command: "npx vitest run {item}"` gates just that item's work.

**Per-item retry state.** Loop counts, feedback, and runtime check ids all gain an
item dimension inside a `forEach` step:

- Loop-count keys become `"<checkId>-><stepId>#<itemIndex>"` (plain
  `"<checkId>-><stepId>"` elsewhere, unchanged). `getCurrentLoopCount`
  (`src/prompts.ts:246`) must match the item-qualified suffix when `ctx.itemIndex` is
  set — cover this explicitly in tests, since it suffix-matches today.
- Feedback keys in `feedbackByStep` become `"<stepId>#<itemIndex>"` inside a
  `forEach` step so one item's failure feedback never leaks into another item's
  prompt.
- `makeRuntimeCheckId` (`src/engine.ts:592`) includes the item index so `/anvil`
  verdict plumbing and check states stay unique per item attempt.
- `resolveStepModelSelection` (`src/engine.ts:475`) receives the **item's** retry
  count, giving per-item model escalation.

**`onFail` scope (v1 restriction).** Inside a `forEach` step, a check's
`onFail: { goto }` must target the step's own id, meaning "retry the current item
with feedback." A `goto` that targets a different step is a validation error in v1 —
jumping out of a half-finished fan-out leaves item state that resume/history cannot
yet represent. `"stop"` and `"continue"` keep their meanings, scoped to the item:
`"continue"` abandons the current item's remaining checks and moves to the next item.
When an item exhausts its loop budget, `forEach.onItemExhausted` decides: `"stop"`
(default) fails the step with a reason naming the item; `"continue"` records the
failure and proceeds, and the step fails at the end only if *every* item failed —
partial failure lands in the step output digest (below) so a later step or check can
act on it.

**Item ordering** is the enumeration order. With `concurrency: 1` (default) items run
strictly sequentially. Fan-out failures under `"stop"` do not cancel already-running
sibling items; the engine stops launching new ones and fails after in-flight items
settle.

### Concurrency

- Default `1`. Local single-GPU inference serializes anyway; sequential is also the
  only mode where main-session delegation is coherent.
- `concurrency > 1` requires subagent delegation: enforce at validation when the
  step's delegation is statically `{ subagent }` or `"none"`/skill (error for the
  latter two), and at runtime when `"auto"` resolves to a non-subagent mode —
  degrade to sequential with a `host.notify` warning rather than failing.
- Implementation is a small worker pool over the item list. The cmux surface manager
  (`src/subagent/runner.ts:120`) already handles multiple live surfaces; verify herdr
  equivalently or cap it to 1 with a documented note.
- Model-selection host calls (`applyStepModelSelection`) are main-session-only state
  and must not be touched from concurrent item workers; subagent model selection
  already travels per-request (`src/engine.ts:260`), which is safe.

### Output capture (step-outputs interaction)

The step's captured output is a per-item digest, built from each item's subagent
summary (or check outcome for main-session items):

```
[1/12] src/foo.ts — ok: <first line of summary>
[2/12] src/bar.ts — FAILED after 3 retries: <reason>
```

Truncate with the same `tail`-style cap the shipped step outputs defines. Retry loops
overwrite per item; re-running the whole step rebuilds the digest.

### Checkpoints, resume, UI

- Add optional `itemIndex` / `itemCount` to `AnvilCheckpoint` (`src/engine.ts:121`);
  emit `step_start` and `check_result` per item. Do **not** put item text in
  checkpoints (size/secrets); the index is enough for attribution.
- **Resume re-runs the whole `forEach` step.** Item-level resume is deliberately out
  of scope (same simplification Feature 10 chose for sub-runs). `resolveResumeState`
  (`src/engine.ts:402`) needs no change beyond documentation; Feature 2's history
  reader should fold per-item checkpoints under their step.
- UI: `formatStatus` / `formatStepWidget` (`src/ui.ts`) gain an item counter, e.g.
  `step 2/4: Write unit test stubs — item 3/12`.

### Validation (`src/validate.ts`)

- Add `"forEach"` to `STEP_KEYS` (`src/validate.ts:20`).
- `forEach.items` must be a function or `{ command, parse? }` with templatable
  `command` and `parse` in `{"lines","json"}`; `concurrency`/`maxItems` positive
  integers; `onItemExhausted` in `{"stop","continue"}`; unknown keys rejected via
  `validateKnownKeys` like every other block.
- Inside a `forEach` step, every check `onFail.goto` (including step- and
  workflow-level defaults that would apply) must equal the step's own id.
- `concurrency > 1` with statically non-subagent delegation is an error (see above).
- Steps elsewhere in the workflow may not `goto` **into** a `forEach` step from
  outside? — No: allow it; re-entering re-runs the whole fan-out, which is coherent.
  Only jumps *out from within* are restricted.

## Implementation steps

1. `src/engine.ts`: pure-move refactor extracting `executeStepAttempt` from the run
   loop; no behavior change, tests stay green.
2. `src/types.ts`: `WorkflowForEach`, `ForEachItemSource`, context item fields.
3. `src/validate.ts`: `forEach` key + rules above.
4. `src/prompts.ts`: `{item}`/`{itemIndex}`/`{itemCount}` in string and command
   templating; item-aware `getCurrentLoopCount`.
5. `src/engine.ts`: enumeration (function + command sources, `maxItems`, empty-list
   handling), per-item loop over `executeStepAttempt`, item-qualified loop/feedback/
   check-id keys, `onItemExhausted`, output digest, checkpoints.
6. Concurrency worker pool (can land as a follow-up commit; sequential-only is
   already the full local-model win).
7. `src/ui.ts`: item progress in status/widget.
8. Docs, skill, example: add a fan-out example workflow (plan step emits a JSON file
   list gated by a deterministic parse check → `forEach` stubs step).
9. Broad test updates.

## Testing

All deterministic per `AGENTS.md`: fake host, no real subagents, no real shell.

- `test/engine.test.ts`: function and command item sources (fake `host.exec`); items
  run in order; per-item context values; empty list passes with notify; `maxItems`
  exceeded fails; item failure retries only that item with only its own feedback;
  `onItemExhausted: "continue"` records and proceeds, fails step only when all items
  fail; per-item retry count drives `resolveStepModelSelection`; digest lands as the
  step output (shipped); checkpoints carry `itemIndex`; resume re-runs the
  whole step.
- `test/prompts.test.ts` / `test/gates.test.ts`: `{item}` renders in prompts and is
  shell-safely injected into commands (hostile item strings: quotes, `$()`,
  newlines); `{loop}` reflects the item's count; placeholders outside `forEach`
  expand empty.
- `test/validate.test.ts`: schema rules, goto-out-of-forEach rejection,
  concurrency/delegation conflicts, unknown keys.
- Concurrency (when landed): pool never exceeds the cap; failure under `"stop"`
  stops new launches but awaits in-flight items; main-session degrade path notifies.

## Docs to update

Full synchronized set per `AGENTS.md`: `src/types.ts` doc comments, `README.md`
(new section with the local-model pattern: enumerate deterministically → fan out →
per-item checks), `skills/anvil-workflow-builder/SKILL.md` (teach the builder to
propose `forEach` when the target model is small/local and to keep per-item prompts
single-outcome), `examples/workflows/demo.ts` or a new fan-out example, feature
backlog cross-links (Features 3, 8).

## Risks & open questions

- **Engine refactor risk.** Extracting `executeStepAttempt` touches the most
  intricate code in the project (loop counts, feedback, model selection, UI, abort).
  Doing it as a standalone no-behavior-change commit with the full suite green is the
  mitigation.
- **Retry-key compatibility.** Item-qualified loop keys change the shape of
  `loopCounts` for `forEach` steps only; `/anvil resume`'s retry seeding
  (`resume-><stepId>`, `src/engine.ts:422`) interacts with suffix matching — decide
  and test whether a resume seed applies to all items or none (recommend: none;
  resume re-runs the fan-out fresh).
- **Hostile item strings.** Items flow into prompts and shell commands; command
  injection is prevented by reusing `renderCommandPlaceholders`, but prompts
  containing adversarial file names are still model-visible. Same trust posture as
  `{input}` today; document it.
- **Concurrency vs. mux backends.** Multiple simultaneous surfaces are proven for
  cmux, unverified for herdr; ship sequential first, gate parallel per backend.
- **Partial-failure semantics** (`onItemExhausted: "continue"`) put failure
  information in the output digest rather than the run state. If real usage wants
  structured per-item results, that is step-outputs follow-up territory (structured
  outputs), not more engine state.
- **Open question:** should `forEach` compose with Feature 10's `uses` (sub-workflow
  per item)? Deferred; revisit once both exist.
