# Independent Review Feature Breakdown

The independent fresh-subagent review feature should be delivered as a sequence of small, reviewable changes instead of one broad implementation. Each phase below should land independently with focused tests and documentation updates.

## Phase 1: Verdict sidecar protocol

Goal: define a reliable transport for structured review verdicts before wiring it into workflow checks.

Scope:
- Add a child-session `anvil_verdict` sidecar writer.
- Include `check_id`, `pass`, and `reason` in the sidecar payload.
- Add parent-side parsing and strict validation.
- Treat missing, malformed, duplicate, or wrong-`check_id` verdicts as transport errors.

Tests:
- Valid sidecar parses successfully.
- Missing sidecar is distinguishable from a failed verdict.
- Malformed sidecar fails clearly.
- Wrong `check_id` fails clearly.

## Phase 2: Dedicated review subagent launcher

Goal: prove a fresh review child session can launch, load only the child extension, and return a verdict.

Scope:
- Add a dedicated review launch mode separate from normal step subagents.
- Ensure Pi flags are valid and explicit.
- Ensure the child extension loads at runtime and exposes `anvil_verdict`.
- Preserve normal subagent behavior for non-review workflow steps.
- Pass workflow-selected model/thinking settings to review sessions.

Tests:
- Command builder launches review sessions with the intended flags.
- Normal subagent launches still allow expected user/project extension behavior.
- Review sessions can write and return a sidecar verdict.
- Model and thinking settings are propagated.

## Phase 3: `AgentCheck.review` contract and gate integration

Goal: add the public workflow contract and map independent verdicts into existing gate results.

Scope:
- Add `review?: { subagent: "cmux" | "herdr" | "auto" }`.
- Add `reviewFallback?: "main" | "fail"` with default `"fail"`.
- Validate review configuration.
- Execute review checks through the dedicated review launcher.
- Convert valid reviewer verdicts into the existing `GateResult` / checkpoint flow.

Tests:
- Existing agent checks without `review` behave unchanged.
- Review checks do not use main-session self-grading by default.
- Backend absence fails clearly by default.
- `reviewFallback: "main"` is honored only for unavailable launch/backend cases.

## Phase 4: Observable result context

Goal: give the fresh reviewer enough observable information to judge text-only and artifact-based outputs without exposing the executor transcript.

Scope:
- Capture a bounded observable step result after step execution.
- Include that result in the independent review prompt.
- Exclude executor conversation, hidden reasoning, and unrelated session transcript.
- Document size limits and truncation behavior.

Tests:
- Chat-only step output reaches the review prompt.
- Subagent summary output reaches the review prompt.
- Executor transcript/internal reasoning is not included.
- Missing output is handled clearly.

## Phase 5: Review isolation and read-only security

Goal: make the independent reviewer structurally constrained enough for untrusted criteria and observable output.

Scope:
- Disable auto-loaded extensions, skills, themes, prompt templates, and context files for review sessions.
- Use no approval / constrained tool access for review sessions.
- Prefer no shell access. If shell access is ever added, use strict argv-level allowlists instead of regex/prefix checks.
- Restrict file inspection to the realpath-resolved workflow cwd.
- Block secret-like paths and symlink escapes.
- Scrub inherited environment variables to the minimum required for Pi and Anvil sidecars.
- Bound and sanitize verdict reasons and failure diagnostics.

Tests:
- Review sessions cannot invoke write/edit/shell mutation tools.
- Reads outside cwd are rejected, including symlink escapes.
- Secret-like files are rejected.
- Environment dumping is not available.
- Failure diagnostics do not persist raw terminal output or secrets.

## Phase 6: Workflow failure semantics

Goal: separately design how workflow step infrastructure failures interact with retry policies.

Scope:
- Decide whether subagent launch/transport failures are hard workflow failures or have a separate documented policy.
- Do not reuse check `onFail` semantics for infrastructure failures unless explicitly documented.
- Keep missing/malformed review verdicts distinct from product-level failed checks.

Tests:
- Step subagent launch failure behavior is deterministic and documented.
- Missing review verdict bypasses normal check `onFail` unless a documented fallback applies.
- Product-level failed verdicts still use existing check failure policy.

## Recommended rollout

Land phases 1–3 first as the minimal independent-review feature. Phase 4 should follow before demonstrating independent review on text-only outputs. Phase 5 should be a dedicated hardening feature with security-focused review. Phase 6 should be handled independently because it changes workflow control-flow semantics beyond review checks.
