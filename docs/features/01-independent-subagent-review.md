# Feature 1 — Independent fresh-subagent review for agent-judged checks

Back to [Feature backlog](../FEATURE.md#1-independent-fresh-subagent-review-for-agent-judged-checks).

## Summary

Let an `AgentCheck` demand an *independent* verdict from a freshly spawned subagent
session that does not share the executing agent's context. This closes the honesty gap
the README already admits: main-session agent-judged checks are self-graded by the same
agent that performed the step and "cannot structurally prevent a rubber-stamp
`pass: true`."

## Motivation

- `README.md` explicitly promises a "future fresh-subagent review pattern when
  independence matters." This feature is that pattern.
- Today an agent check either runs in the main session (self-grading) or names a
  subagent via `check.agent`, but `check.agent` is only a *prompt hint*: see
  `buildAgentCheckInstruction` in `src/prompts.ts:169`, which merely appends
  "If you use subagents for evaluations, delegate this evaluation to subagent ...".
  Nothing structurally guarantees an independent evaluator or a clean context.
- Anvil already knows how to spawn a clean pi session and capture its result: the
  cmux/herdr runner in `src/subagent/runner.ts` plus the child extension in
  `src/subagent/child.ts`.

## Current state (grounding)

- `AgentCheck` (`src/types.ts:54`) has `type`, `id`, `name`, `prompt`, `agent`,
  `timeoutMs`, `onFail`.
- `executeAgentCheck` (`src/gates.ts:118`) drives the verdict flow entirely through the
  main session: it calls `host.sendInstruction`, `host.waitForTurnComplete`, and
  `host.awaitVerdict`, racing a verdict against turn completion, with one re-prompt via
  `buildVerdictReprompt`.
- The verdict arrives through the `anvil_verdict` tool (`src/index.ts:311`) and the
  `VerdictBus` (`src/gates.ts:24`). The engine correlates verdicts by `checkId`
  (`makeRuntimeCheckId`, `src/engine.ts:592`).
- Subagent step execution already exists end to end via `EngineHost.runSubagent`
  (`src/engine.ts:61`, implemented in `src/index.ts:375`), `SubagentStepRunRequest` /
  `SubagentStepRunResult` (`src/engine.ts:35`/`:51`), and
  `runSubagentWithBackend` (`src/subagent/runner.ts:151`), which returns the child's
  last assistant message as `summary` via `extractLastAssistantText`
  (`src/subagent/runner.ts:74`).

## Design

### Schema (`src/types.ts`)

Extend `AgentCheck` with an optional `review` field:

```ts
export type AgentReviewMode =
    | { subagent: WorkflowSubagentBackend }   // force this backend
    | { subagent: "auto" };                    // detect like delegation "auto"

export interface AgentCheck {
    type: "agent";
    // ...existing fields...
    /**
     * When set, the verdict is produced by a fresh, independent subagent session
     * that does not share the executing agent's context. Falls back to main-session
     * evaluation only if explicitly allowed (see fallback).
     */
    review?: AgentReviewMode;
    /** When review is set but no backend is available: "main" (self-grade) or "fail". Default "fail". */
    reviewFallback?: "main" | "fail";
}
```

Rationale for `reviewFallback` defaulting to `"fail"`: the whole point is independence.
Silently self-grading when no backend exists would reintroduce the rubber-stamp the
feature removes, so the safe default is to fail the check with a clear reason. A workflow
author who prefers graceful degradation opts into `"main"`.

### Verdict transport from an isolated child

The reviewer must return a structured `pass`/`reason`, not just prose. Two viable
mechanisms:

1. **Sidecar verdict file (recommended).** The child extension (`src/subagent/child.ts`)
   already writes a `<sessionFile>.exit` sidecar on `agent_end`. Add an `anvil_verdict`
   tool inside the child extension that writes `<sessionFile>.verdict.json`
   (`{ pass, reason }`). The parent reads that file after `pollForExit`, exactly where
   `runSubagentWithBackend` already reads the session file. This keeps the isolation
   guarantee real: the reviewer's only inputs are the criteria + observable result, and
   its only output is the verdict file.
2. **Parse the last assistant message.** Reuse `extractLastAssistantText` and require the
   reviewer to end with a fenced `anvil-verdict` JSON block. Simpler but brittle; prefer
   option 1.

### Reviewer prompt

Add `buildIndependentReviewTask(...)` to `src/prompts.ts`, modeled on
`buildSubagentStepTask` (`src/prompts.ts:138`). It must include **only**:

- the workflow name and the step id being reviewed,
- the rendered check criteria (`renderTemplatable(check.prompt, ctx)`),
- an instruction to inspect the working tree / artifacts directly (the reviewer starts in
  `ctx.cwd`) rather than trusting any narrative,
- the exact `anvil_verdict` contract (check_id, pass, reason).

It must **not** include the step's executor conversation or the step prompt's internal
reasoning — that is the independence guarantee.

### Engine / gates wiring

- Add an optional `EngineHost.runReviewSubagent?(request, signal)` OR reuse
  `runSubagent` with a discriminator on the request. Prefer a dedicated method so the
  result type can be `{ pass, reason, exitCode, errorMessage, sessionFile }` instead of a
  free-form summary.
- In `executeAgentCheck` (`src/gates.ts:118`), branch at the top: if
  `check.review` is set, resolve the backend (honoring `"auto"` via
  `detectAutoSubagentBackend`, `src/prompts.ts:227`); if available, call the review path
  and convert its result straight into a `GateResult`; if unavailable, apply
  `reviewFallback` (`"fail"` → `pass:false, reason:"no independent reviewer available"`;
  `"main"` → existing main-session flow).
- The engine passes `checkId` through unchanged; the reviewer echoes it, so the existing
  correlation and checkpoints (`check_result`) keep working without change.

### Validation (`src/validate.ts`)

- Add `review` and `reviewFallback` to `AGENT_CHECK_KEYS` (`src/validate.ts:36`).
- In `validateAgentCheck` (`src/validate.ts:260`): validate `review` is
  `{ subagent: "cmux" | "herdr" | "auto" }` and `reviewFallback` is `"main"` | `"fail"`.
- Keep delegation availability preflight unchanged. Review backend availability is evaluated
  when the check runs so `reviewFallback: "fail"` can produce a normal failed `GateResult`,
  checkpoint the result, and apply the check's `onFail` policy. Only explicit
  `reviewFallback: "main"` degrades to main-session grading.

## Implementation steps

1. `src/types.ts`: add `AgentReviewMode`, `review`, `reviewFallback` to `AgentCheck`.
2. `src/validate.ts`: extend key sets and `validateAgentCheck`; add a
   `validateAgentReview` helper alongside `validateDelegation`.
3. `src/subagent/child.ts`: register an `anvil_verdict` tool that writes
   `<sessionFile>.verdict.json`; keep the existing exit-sidecar behavior.
4. `src/subagent/runner.ts`: add reading of the verdict sidecar to
   `runSubagentWithBackend` (or a thin `runReviewSubagent` wrapper) and surface
   `{ pass, reason }` in the result.
5. `src/prompts.ts`: add `buildIndependentReviewTask`.
6. `src/engine.ts`: add `runReviewSubagent?` to `EngineHost`; thread review requests.
7. `src/gates.ts`: branch `executeAgentCheck` on `check.review`.
8. `src/index.ts`: implement `runReviewSubagent` on the host (reusing
   `runHerdrSubagent` / `createCmuxSubagentRunner`); expose runtime backend availability to gates.
9. Docs + skill + example.

## Testing

- `test/gates.test.ts`: with a fake host, assert that when `check.review` is set the
  review path is taken, the returned `{ pass, reason }` becomes the `GateResult`, and the
  main-session `sendInstruction` flow is **not** invoked.
- Fallback matrix: backend unavailable + `reviewFallback:"fail"` → failing gate with the
  documented reason; `+ "main"` → falls back to existing flow.
- `test/subagent.test.ts`: verdict-sidecar parsing (present / malformed / missing).
- A prompt test asserting `buildIndependentReviewTask` contains the criteria and the
  `anvil_verdict` contract but not the step's executor prompt (independence assertion, as
  called out in the backlog risk).
- Keep tests deterministic per `AGENTS.md`: fake the backend adapter; never spawn real
  cmux/herdr.

## Docs to update

- `README.md`: replace the "future fresh-subagent review pattern" caveat with real usage.
- `skills/anvil-workflow-builder/SKILL.md`: add `review` to the agent-check authoring
  guidance and explain the `reviewFallback` tradeoff.
- `examples/workflows/demo.ts`: make the `summary-quality` agent check independent to
  demonstrate the pattern.

## Risks & open questions

- **Independence must be real.** The reviewer's prompt and inputs are the guarantee; test
  it explicitly. Do not pass the executor transcript.
- **Cost/latency.** Every independent review spawns a session. Document that this is for
  checks where independence matters, consistent with the README's existing guidance about
  subagents on non-trivial steps.
- **Backend requirement.** Independent review needs cmux or herdr. Decide whether a
  future in-process "sub-session" backend (no multiplexer) is worth it; out of scope here.
- **Reviewer tool access.** Review sessions use the dedicated no-approval launcher,
  disable discovered resources and shell/mutation tools, and override `read`, `grep`,
  `find`, and `ls` with bounded implementations confined to the realpath-resolved
  workflow cwd. Symlink escapes and secret-like paths are denied. The launcher also
  creates an ephemeral home and Pi agent directory containing only the selected model
  provider's auth/model configuration; unrelated provider and cloud credentials are
  neither inherited nor copied, and the identity directory is removed after the child
  exits. These controls structurally constrain reviewer-invoked tools, but they are not
  a general-purpose OS sandbox for the Pi process.
- **Verdict reason privacy.** Reviewer prose is untrusted and may quote secrets from an
  artifact or provider response. Anvil validates the bounded `reason` field as part of
  the sidecar protocol but replaces it with a fixed pass/fail reason before writing or
  consuming the sidecar. Reviewer-controlled prose therefore cannot reach checkpoints,
  UI, retry feedback, reports, or resume prompts.
- **Timeout semantics.** `check.timeoutMs` defaults to 300_000 (`src/gates.ts:22`),
  tuned for a main-session verdict wait — but an independent review spawns a whole
  session that must start up and inspect the tree, closer in cost to a subagent step
  (default 1_800_000, `src/types.ts:93`). Decide which knob governs the review (reusing
  `check.timeoutMs` is simplest but its default is likely too tight; a separate
  `review.timeoutMs` with a larger default avoids surprising timeouts) and document it.
- **Open question:** should `review` also be allowed at step/workflow defaults level
  (apply to all agent checks) rather than per check? Start per-check; add defaults later
  if demand appears.
