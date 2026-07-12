import { defineWorkflow } from "anvil";

const model = "openai-codex/gpt-5.6-terra:medium";
const implementationLoopLimit = 3;
const reviewRemediationLoopLimit = 3;

function specialistReviewProtocol(): string {
	return `Review-round protocol:
- Authoritative round state: {outputs.review-round-context}
- In ROUND 1, perform one comprehensive discovery pass and report every finding in this focus area at once.
- In ROUND 2, verify the blocker ledger supplied in the remediation context and perform one final comprehensive pass for genuinely new blockers.
- In ROUND 3 or later, this is CONVERGENCE: gate only on unresolved ledger finding IDs, incomplete remediations, or regressions directly introduced by those remediations.
- The CONVERGENCE ledger freezes each finding's ID, root cause, affected assets, threat boundary, reproduction, acceptance criteria, and required regression. Map variants to that frozen finding; do not broaden its scope, threat model, required assets, or acceptance criteria without concrete evidence that remediation introduced a CRITICAL-NEW issue.
- During CONVERGENCE, the correctness/contracts reviewer is the sole verifier of frozen-ledger remediation. Other specialists must only scan for CRITICAL-NEW issues introduced by remediation and report unrelated or previously latent items as non-blocking follow-up work.
- Review against the explicit feature requirements and documented threat boundary. Do not convert optional hardening, an excluded OS-sandbox guarantee, or a hypothetical attacker capability outside that boundary into a blocker.
- Emergency exception: a remediation-introduced credential exposure, arbitrary code execution, destructive data loss, or sandbox escape may still block; label it CRITICAL-NEW and provide concrete evidence that the remediation introduced it.
- Do not relitigate accepted design decisions without new evidence. Blocking findings must violate an explicit requirement or documented threat boundary, include a concrete failure path, and specify an exact regression test that reproduces the failure.
- Assign stable finding IDs, preserve them across rounds, and list every ledger ID as resolved or unresolved. Begin the response with exactly one round label: ROUND 1, ROUND 2, or CONVERGENCE.`;
}

export default defineWorkflow({
	name: "feature-forge",
	description: "Research-backed, security-reviewed, test-first feature implementation with focused verification, coverage, review, and issue capture.",
	defaults: {
		delegation: "auto",
		onFail: "stop",
		maxLoops: implementationLoopLimit,
	},
	steps: [
		{
			id: "research-and-plan",
			title: "Research feature and plan action",
			model,
			prompt: `For this feature request:
{input}

Research the requested feature and build a concise plan of action before any tests or implementation begin.

Requirements:
- Inspect the repository to understand existing architecture, related code paths, tests, docs, public contracts, and conventions.
- Identify the requested behavior, acceptance criteria, affected layers, edge/failure cases, risks, and open questions.
- Include a security design and threat-boundary assessment before implementation. Explicitly consider subprocesses, shell startup, inherited environment variables, tool permissions, filesystem/workspace boundaries, symlink escapes, secrets, and diagnostic sanitization when relevant; state why each area is not applicable when it is outside the feature's scope.
- Require isolation/security regression cases for every applicable trust boundary, including secret inheritance, shell startup hooks, mutation-tool access, cwd/realpath enforcement, symlink escapes, secret-like paths, and sanitized errors.
- Use web or external research only when the feature depends on external APIs, libraries, platform behavior, or domain details not already present in the repo.
- Produce a concise implementation plan with ordered steps, test strategy, files likely to change, focused verification commands for affected tests/modules, and the final full-suite/coverage commands.
- Do not modify tests or production code in this step unless the user explicitly requested a plan artifact file; this step is for research and planning only.`,
		},
		{
			id: "review-security-design",
			title: "Review security design before implementation",
			model,
			delegation: "auto",
			prompt: `For this feature request:
{input}

Review the proposed plan before tests or implementation begin.

Research and implementation plan:
{outputs.research-and-plan}

Requirements:
- Focus on the security design, privacy boundaries, unsafe input handling, and destructive-operation risks in the proposed architecture.
- Identify applicable trust boundaries involving subprocesses, shell startup, inherited environment variables, tools, filesystem/workspace access, symlinks, secrets, and diagnostics.
- Report concrete safeguards and isolation/security regression cases the implementation and test-stub steps must address; distinguish required work from optional hardening.
- Treat a missing threat-boundary assessment, permissive-by-default design, inherited-secret exposure, unconstrained mutation access, unsafe path handling, or missing applicable security tests as high-priority implementation feedback.
- This is an advisory review, not an approval gate: report findings even when they are blocking for the eventual implementation, and do not send the workflow back to planning.
- Do not modify tests or production code; produce a concise, actionable security implementation brief for subsequent steps.
- If no security design issues are present, state that explicitly.`,
		},
		{
			id: "write-test-stubs",
			title: "Write unit test stubs",
			model,
			prompt: `For this feature request:
{input}

Using the research, plan, and advisory security design review below, write the unit test stubs needed to cover the requested behavior before implementation.

Research and implementation plan:
{outputs.research-and-plan}

Security design review:
{outputs.review-security-design}

Requirements:
- Follow this TypeScript repository's Vitest conventions and keep tests under the appropriate test/*.test.ts file.
- Stub all important success, edge, and failure cases implied by the request.
- Add every applicable isolation/security regression case identified by the plan and security review. Cover secret inheritance, shell startup hooks, mutation-tool access, cwd/realpath enforcement, symlink escapes, secret-like paths, and sanitized diagnostics when those trust boundaries exist.
- Keep stubs compileable; placeholders may fail until the implementation step completes.
- Do not implement production behavior in this step beyond minimal compile support needed for the tests.
- If the request changes commands, public TypeScript contracts, README behavior, or workflow examples, include contract test stubs too.`,
		},
		{
			id: "review-round-context",
			title: "Record review round context",
			runInMain: true,
			prompt: `Create the persistent context for the next implementation and specialist-review round. Do not modify files or evaluate the feature.

The zero-based remediation-loop count is {loop}:
- 0: output "ROUND 1" and "Blocker ledger: none yet."
- 1: output "ROUND 2" followed by the aggregate feedback appended below as the blocker ledger.
- 2 or greater: output "CONVERGENCE" followed by the aggregate feedback appended below as the frozen blocker ledger.

Call the anvil_output tool exactly once with step_id "review-round-context" and only that round label plus ledger. Preserve every finding ID and its frozen root cause, affected assets, threat boundary, reproduction, acceptance criteria, and required regression from the aggregate feedback.`,
			checks: [
				{
					type: "deterministic",
					id: "review-round-marker",
					name: "Review round context is ready",
					command: "test -n {loop}",
				},
			],
		},
		{
			id: "assess-remediation-feasibility",
			title: "Assess remediation feasibility and choose an architecture",
			model: "openai-codex/gpt-5.6-sol:high",
			prompt: `For this feature request:
{input}

Review-round context:
{outputs.review-round-context}

Before implementation, assess the feasibility of the current remediation ledger. In ROUND 1, state that implementation may proceed from the existing plan. In later rounds:
- Treat the frozen finding scope, threat boundary, acceptance criteria, and required regression as authoritative; do not silently broaden them.
- Determine whether the requested guarantee is achievable using the repository's current APIs and architecture.
- If the prior approach cannot meet the criterion, choose a materially different architecture that can; do not propose another equivalent check at the same race or trust boundary.
- Reconcile the plan with the documented non-goals (including any non-OS-sandbox boundary) and explain why the chosen design stays within scope.
- Produce an autonomous, concrete implementation decision with affected modules, a focused regression, and verification commands. Do not defer the decision to a human reviewer.`,
		},
		{
			id: "implement-feature",
			title: "Implement feature and satisfy tests",
			model: "openai-codex/gpt-5.6-sol:high",
			retryModelSelections: [
				{ retry: 3, model: "openai-codex/gpt-5.6-sol:xhigh" },
				{ retry: 8, model: "openai-codex/gpt-5.6-sol:max" },
			],
			prompt: `Using the research, plan, and advisory security design review, implement this feature request and complete/fill in the unit test stubs:
{input}

Research and implementation plan:
{outputs.research-and-plan}

Security design review:
{outputs.review-security-design}

Review-round context and blocker ledger (empty before review begins):
{outputs.review-round-context}

Remediation feasibility decision:
{outputs.assess-remediation-feasibility}

Requirements:
- Implement real logic in the appropriate core module before touching thin command/extension wiring.
- On a review retry, remediate every unresolved finding ID in the frozen blocker ledger and report how each was addressed; do not expand its frozen root cause, affected assets, threat boundary, acceptance criteria, or required regression.
- Follow the feasibility decision. A retry must make a materially different architectural change from any rejected approach; do not add another verification, retry, or test seam at the same unresolved trust boundary.
- Resolve architectural impasses autonomously: select and implement the feasible in-scope design, or remove unsupported guarantee claims and retain only the documented threat boundary. Do not defer the decision to a human reviewer.
- Before changing production code for a blocker, add a focused regression test that reproduces its concrete failure path and acceptance criterion. Keep that test as permanent coverage and show that it passes after remediation.
- For security, privacy, or trust-boundary blockers, perform a focused security remediation pass: test the exact exploit plus relevant boundary/partial-input variants, prefer fail-closed behavior where safe sanitization cannot be proven, and rerun the affected isolation/security tests.
- Fill in the unit test stubs with meaningful assertions; do not delete coverage unless it is obsolete and replaced.
- Keep CLI command behavior, README documentation, workflow examples, and TypeScript contracts in sync when the requested feature affects them.
- Run the plan's most focused affected tests and type checks first; fix those failures before spending time on the full repository check and coverage suite.
- Then run and fix the full test suite until all tests pass and coverage is at least 85%.
- Address any feedback from failed verification or review checks before finishing.`,
			checks: [
				{
					type: "deterministic",
					id: "focused-tests",
					name: "Affected tests pass before full verification",
					command: "npx vitest run --changed",
					timeoutMs: 900_000,
					onFail: { goto: "implement-feature", maxLoops: implementationLoopLimit, onExhausted: "stop", feedback: true },
				},
				{
					type: "deterministic",
					id: "tests-and-coverage",
					name: "All tests pass with >=85% coverage",
					command: "npm run check && npx vitest run --coverage",
					timeoutMs: 1_800_000,
					onFail: { goto: "implement-feature", maxLoops: implementationLoopLimit, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-correctness-contracts",
			title: "Review correctness and contracts",
			model,
			retryModelSelections: [
				{ retry: 1, model: "openai-codex/gpt-5.6-sol:medium" },
				{ retry: 2, model: "openai-codex/gpt-5.6-sol:high" },
			],
			// Run each specialist review independently before the aggregate gate decides whether to remediate.
			delegation: "auto",
			prompt: `Review the changes made for this feature request:
{input}

Focus only on correctness and contracts.

${specialistReviewProtocol()}

Requirements:
- Verify the implementation satisfies the requested behavior, acceptance criteria, edge cases, and failure cases.
- Check public TypeScript contracts, command behavior, workflow schema compatibility, and architecture boundaries.
- Treat correctness regressions, broken contracts, data loss, architecture violations, and incomplete required behavior as blocking.
- In CONVERGENCE, act as the sole verifier of frozen-ledger remediation; assess every unresolved ledger item only against its frozen scope and acceptance criteria.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
		},
		{
			id: "review-security-privacy",
			title: "Review security and privacy",
			model,
			retryModelSelections: [
				{ retry: 1, model: "openai-codex/gpt-5.6-sol:medium" },
				{ retry: 2, model: "openai-codex/gpt-5.6-sol:high" },
			],
			delegation: "auto",
			prompt: `Review the changes made for this feature request:
{input}

Focus only on security and privacy.

${specialistReviewProtocol()}

Requirements:
- Look for unsafe shell execution, command injection, path traversal, unsafe file-system access, secret leakage, untrusted workflow input handling, and environment variable exposure.
- Check whether new logs, prompts, errors, docs, tests, or command output could expose private data or credentials.
- Treat exploitable input handling, secret/privacy leakage, unsafe command construction, and destructive file operations as blocking.
- In CONVERGENCE, do not re-evaluate frozen ledger items; report only concretely evidenced CRITICAL-NEW issues introduced by remediation, plus non-blocking follow-ups.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
		},
		{
			id: "review-performance-reliability",
			title: "Review performance and reliability",
			model,
			retryModelSelections: [
				{ retry: 1, model: "openai-codex/gpt-5.6-sol:medium" },
				{ retry: 2, model: "openai-codex/gpt-5.6-sol:high" },
			],
			delegation: "auto",
			prompt: `Review the changes made for this feature request:
{input}

Focus only on performance and reliability.

${specialistReviewProtocol()}

Requirements:
- Look for inefficient file scans, excessive subprocess work, unbounded loops, weak timeout handling, flaky async behavior, race conditions, resource leaks, and large-repo scalability problems.
- Check retry behavior, concurrency safety, deterministic execution, and failure-mode handling.
- Treat runaway work, flaky or nondeterministic behavior, resource leaks, timeout hazards, and reliability regressions as blocking.
- In CONVERGENCE, do not re-evaluate frozen ledger items; report only concretely evidenced CRITICAL-NEW issues introduced by remediation, plus non-blocking follow-ups.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
		},
		{
			id: "review-tests-maintainability-docs",
			title: "Review tests, maintainability, and docs",
			model,
			retryModelSelections: [
				{ retry: 1, model: "openai-codex/gpt-5.6-sol:medium" },
				{ retry: 2, model: "openai-codex/gpt-5.6-sol:high" },
			],
			delegation: "auto",
			prompt: `Review the changes made for this feature request:
{input}

Focus only on tests, maintainability, and documentation.

${specialistReviewProtocol()}

Requirements:
- Check Vitest coverage quality, meaningful assertions, edge/failure coverage, contract tests, and whether verification should be rerun.
- Check readability, repository conventions, TypeScript style, import style, naming, and whether the design is easy to maintain.
- Check that README, skills, examples, and command documentation stay aligned when behavior or public contracts change.
- Treat missing required tests, misleading documentation, convention violations that cause maintenance risk, and evidence of stale verification as blocking.
- In CONVERGENCE, do not re-evaluate frozen ledger items; report only concretely evidenced CRITICAL-NEW issues introduced by remediation, plus non-blocking follow-ups.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
		},
		{
			id: "aggregate-review",
			title: "Aggregate reviews and record non-blockers",
			retryModelSelections: [
				{ retry: 1, model: "openai-codex/gpt-5.6-sol:medium" },
				{ retry: 2, model: "openai-codex/gpt-5.6-sol:high" },
			],
			delegation: "auto",
			prompt: `Aggregate the specialist reviews for this feature request:
{input}

Authoritative review round:
{outputs.review-round-context}

Round enforcement:
- In ROUND 1, build a complete, de-duplicated blocker ledger from all specialist reviews.
- In ROUND 2, verify remediation of the blocker ledger in the review-round context and permit the specialists' final discovery of genuinely new blockers.
- In CONVERGENCE, the blocker ledger in the review-round context is frozen, including each finding's root cause, affected assets, threat boundary, reproduction, acceptance criteria, and required regression. Only an unresolved frozen ledger item, an incomplete remediation within that frozen scope, or a concretely evidenced CRITICAL-NEW issue introduced by remediation may block.
- In CONVERGENCE, map variants sharing a frozen blocker's root cause and acceptance criteria to that existing ID; do not broaden its threat model, affected assets, or requirements while retaining its ID.
- In CONVERGENCE, downgrade unrelated, previously latent, optional-hardening, or out-of-boundary items to non-blocking follow-up work even if a specialist labelled them blocking.
- Preserve stable finding IDs and show every blocker as resolved or unresolved so implementation receives an actionable ledger.

Correctness and contracts review:
{outputs.review-correctness-contracts}

Security and privacy review:
{outputs.review-security-privacy}

Performance and reliability review:
{outputs.review-performance-reliability}

Tests, maintainability, and docs review:
{outputs.review-tests-maintainability-docs}

Requirements:
- Synthesize and de-duplicate all specialist findings under the round rules above.
- Treat correctness regressions, broken contracts, missing required tests, failing verification, data loss, security/privacy issues, architecture violations, runaway work, and reliability regressions as blocking only when allowed by the current round.
- If any blocking issues remain, report them clearly with stable IDs, originating reviewer, affected files or behavior, concrete reproduction steps, remediation acceptance criteria, and the exact regression test required to prove the fix; do not fix code or append issue-file entries in this step.
- Do not mark a blocker resolved unless focused regression coverage reproduces its frozen failure path and passes with the remediation.
- When remediation is rejected repeatedly, require a materially different architecture in the next feasibility decision; do not preserve a blocker while expanding its frozen acceptance criteria.
- Only when no blockers remain, append non-blocking findings to docs/ISSUE.md using that file's existing style and avoid duplicates.
- If you find no issues, state that explicitly.
- Begin with the authoritative ROUND 1, ROUND 2, or CONVERGENCE label and end with exactly one decision: "blocking findings remain", "only non-blocking issues recorded", or "no review issues found".`,
			checks: [
				{
					type: "deterministic",
					id: "aggregate-workspace-valid",
					name: "Aggregated issue updates are well formed",
					command: "git diff --check",
				},
				{
					type: "agent",
					id: "blocking-review",
					name: "No blocking review findings",
					prompt: `Evaluate the aggregated specialist reviews for this feature request:
{input}

Correctness and contracts review:
{outputs.review-correctness-contracts}

Security and privacy review:
{outputs.review-security-privacy}

Performance and reliability review:
{outputs.review-performance-reliability}

Tests, maintainability, and docs review:
{outputs.review-tests-maintainability-docs}

Aggregated review and blocker ledger:
{outputs.aggregate-review}

Pass only if all of the following are true:
- The aggregated ledger has no unresolved blockers permitted by the current review round.
- The aggregator correctly applied ROUND 1, ROUND 2, or CONVERGENCE rules; unrelated or previously latent new convergence findings do not fail the gate even if a specialist labelled them blocking, and variants of a frozen blocker retain its existing ID.
- Every resolved blocker has a focused regression test covering its concrete failure path and acceptance criterion.
- Any non-blocking issues discovered during review were added to docs/ISSUE.md.
- The implementation still satisfies the feature request and repository conventions.

Fail if the aggregate decision says blocking findings remain, an allowed blocker is unresolved, round rules or required issue documentation were not followed, contradictory conclusions require human follow-up, or tests/coverage must be rerun. If failing, the verdict reason must preserve every unresolved finding ID and acceptance criterion from the aggregated ledger so the next review-round context can carry them forward.`,
					onFail: { goto: "review-round-context", maxLoops: reviewRemediationLoopLimit, onExhausted: "stop", feedback: true },
				},
			],
		},
	],
});
