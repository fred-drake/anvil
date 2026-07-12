# Feature 1 — Independent fresh-subagent review for agent-judged checks

Back to [Feature backlog](../FEATURE.md#1-independent-fresh-subagent-review-for-agent-judged-checks).

## Status

Shipped. An `AgentCheck` can require an independent verdict from a freshly spawned
review session that does not share the executing agent's context. This closes the
honesty gap documented in the README: main-session agent-judged checks are self-graded
and cannot structurally prevent a rubber-stamp `pass: true`.

## Grading and trust boundaries

The two grading modes use separate transports:

- **Main-session grading** is in-process. The main `anvil_verdict` tool publishes into
  the `VerdictBus` used by `executeAgentCheck` in `src/gates.ts`; no sidecar is involved.
- **Independent-review grading** starts an isolated reviewer child; the child writes a verdict sidecar and the parent reads and validates it after the child exits.
  The literal wire contract is `{ check_id, pass, reason }`.

The parent accepts exactly `{ check_id, pass, reason }` and rejects payloads with extra
fields or invalid fields. The parent-side `readIndependentReviewVerdict` parser in
`src/subagent/runner.ts` requires one bounded UTF-8 JSON record. It rejects a
missing, malformed, duplicate, or wrong-`check_id` sidecar as transport errors. It also
rejects symlinks, non-regular or oversized files, extra or invalid fields, empty fields,
oversized reasons, and unsupported control characters. A failed transport is an
infrastructure error, not a reviewer-authored failed gate. Reviewer prose is untrusted;
Anvil replaces it with a fixed parent-controlled pass/fail reason before propagation.

Runtime check IDs continue to correlate the verdict with the active check. The child
must echo the exact ID supplied in its review task, and only the parent converts a
validated record into a gate result.

## Public contract

Independent grading is selected per agent check:

```ts
export type AgentReviewMode =
	| { subagent: WorkflowSubagentBackend }
	| { subagent: "auto" };

export interface AgentCheck {
	type: "agent";
	// ...other fields...
	review?: AgentReviewMode;
	reviewFallback?: "main" | "fail";
}
```

`reviewFallback` defaults to `"fail"`. This preserves the requested independence when
no backend is available. A workflow author can explicitly choose `"main"` to degrade
to self-grading. Review availability is evaluated when the check runs, allowing an
unavailable reviewer to produce the documented failed gate and follow the check's
`onFail` policy. This typed backend-unavailable case is the only review failure to which
`reviewFallback: "main"` applies.

A valid review verdict with `pass: false` is a product-level failed gate: it is
checkpointed and follows `onFail`. Review launch failures, timeouts, child non-zero
exits, and missing, malformed, duplicate, or wrong-ID verdict transport are hard
infrastructure errors. They produce no synthetic `check_result`, retry feedback, or
loop increment and cannot fall back to main-session grading. Normal delegated-step
launch, timeout, transport, and non-zero failures use the same hard-stop boundary,
including inside `forEach`: they bypass check retry and `onItemExhausted: "continue"`,
stop before later items launch, and do not publish a per-item continuation digest.
Persisted infrastructure diagnostics use fixed parent-controlled messages and omit
child/provider output, reviewer prose, item text, secrets, and paths.

## Reviewer inputs

`buildIndependentReviewTask` in `src/prompts.ts` supplies only:

- workflow, step, and check identities, bounded to 256 UTF-8 bytes; unsafe or oversized
  identities use deterministic SHA-256 aliases across prompt text and launcher requests;
- sanitized check criteria rendered without prior `{outputs.<step-id>}` values;
- the current attempt's bounded **observable step result**;
- guidance to inspect the working tree directly; and
- the exact `anvil_verdict` contract: `{ check_id, pass, reason }`.

The observable result comes only from explicit main/chat `anvil_output` capture or a
successful delegated subagent's final summary. Missing or empty output becomes a fixed
missing-output state. It is prompt-only and is never added to checkpoints, summaries,
evidence, retry feedback, sidecars, UI diagnostics, or launcher errors.

The result limit is **8 KiB including the truncation marker**, measured in UTF-8 bytes.
Capture preprocessing inspects at most the final 64 Ki UTF-16 code units, bounding
sanitizer and byte-copy work. A partial line at that scan boundary is discarded, or the
output is reported missing if no complete line remains. Oversized values retain a
deterministic UTF-8-safe tail with a visible marker.

Unsupported control characters are normalized. Conservative redaction covers common
Slack, GitLab, GitHub, OpenAI, AWS, NPM, JWT, cookie, authorization, database-credential,
and private-key forms, including quoted `.env` and JSON values. Ambiguous clipped or
unmatched private-key markers fail closed as missing output. Redaction is defense in
depth, not a complete secret detector; steps must report only intentionally disclosed
observable text.

The observable result is untrusted quoted data, and the reviewer is told not to follow
instructions in it. The prompt does not contain the executor transcript, hidden
reasoning, raw terminal or provider output, retry feedback, or prior workflow output.

Identity and filesystem-name bounds also apply before launch: 256-byte identity bounds cover launcher names and path/session identities; path components longer than 255 bytes
are aliased, and each complete generated task/session basename, sidecar basename, and
atomic temporary basename is capped at 255 bytes.

## Isolation controls

`src/subagent/runner.ts`, `src/subagent/child.ts`, and `src/subagent/review-fs.ts`
implement the review boundary:

- the launcher uses trusted absolute Node/Pi paths, `env -i`, and Bash
  `--noprofile --norc`;
- discovered extensions, skills, themes, prompt templates, and context files are
  disabled;
- the exact tool allowlist is `read`, `grep`, `find`, `ls`, and `anvil_verdict`; shell,
  edit, write, and unrestricted built-in filesystem tools are absent;
- reads are confined to the realpath-resolved workflow cwd, with parent and absolute
  escapes rejected, symlink traversal denied, and descriptor-aware checks protecting
  against traversal races;
- secret-like files and directories such as `.env`, credential/key files, `.ssh`,
  `.aws`, and `.git` are hidden or rejected recursively;
- traversal, reads, search output, and UTF-8 processing are bounded; and
- each reviewer receives an ephemeral home and Pi agent directory containing only the
  selected provider's required authentication/model configuration. Unrelated provider,
  cloud, and ambient credentials are not inherited or copied.

Launch, exit, backend, and transport diagnostics omit raw child/provider output. The
reviewer-controlled reason is replaced with a fixed pass/fail reason before it can
reach checkpoints, UI, retry feedback, reports, or resume prompts.

These controls constrain the Pi process through startup configuration and reviewer tool
access. They are intentionally **not a general-purpose OS or kernel sandbox**.

## Runtime flow

1. Validation accepts `review: { subagent: "cmux" | "herdr" | "auto" }` and
   `reviewFallback: "main" | "fail"`.
2. `executeAgentCheck` resolves the requested backend. An explicit main fallback uses
   the existing in-process path; otherwise unavailable required review fails closed.
3. `buildIndependentReviewTask` constructs the bounded prompt without executor context.
4. The review-only runner creates an isolated identity and launches the child.
5. The child exposes only the review filesystem tools and `anvil_verdict`, then writes
   one exclusive verdict sidecar.
6. The parent strictly validates the sidecar and returns a sanitized gate result.
7. Cleanup removes the ephemeral reviewer identity and temporary artifacts.

## Regression coverage

The shipped tests cover:

- independent routing without invoking the main-session instruction path;
- unavailable-backend fallback behavior;
- criteria/result prompt isolation and sanitization;
- fixed executable paths, `env -i`, non-startup Bash, disabled discovered resources,
  and environment/provider credential isolation;
- the exact read-only tool allowlist;
- canonical cwd, parent/absolute rejection, direct and traversal-race symlink defenses,
  and recursive sensitive-path denial;
- sidecar success plus missing, malformed, duplicate, symlinked, oversized,
  wrong-`check_id`, invalid-field, and unsafe-reason cases; and
- suppression of reviewer prose and raw backend/transport diagnostics.

The documentation contract is covered in `test/workflow-contract.test.ts`, while
runtime and isolation behavior is covered primarily in `test/subagent.test.ts`,
`test/gates.test.ts`, and `test/anvil-command.test.ts`.
