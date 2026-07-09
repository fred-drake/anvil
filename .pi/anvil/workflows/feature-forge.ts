import { defineWorkflow } from "anvil";

const model = "openai-codex/gpt-5.5:high";

export default defineWorkflow({
	name: "feature-forge",
	description: "Research-backed, test-first feature implementation with verification, coverage, review, and issue capture.",
	defaults: {
		delegation: "auto",
		onFail: "stop",
		maxLoops: 10,
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
- Use web or external research only when the feature depends on external APIs, libraries, platform behavior, or domain details not already present in the repo.
- Produce a concise implementation plan with ordered steps, test strategy, files likely to change, and verification commands.
- Do not modify tests or production code in this step unless the user explicitly requested a plan artifact file; this step is for research and planning only.`,
		},
		{
			id: "write-test-stubs",
			title: "Write unit test stubs",
			model,
			prompt: `For this feature request:
{input}

Using the research and plan from the previous step, write the unit test stubs needed to cover the requested behavior before implementation.

Requirements:
- Follow this TypeScript repository's Vitest conventions and keep tests under the appropriate test/*.test.ts file.
- Stub all important success, edge, and failure cases implied by the request.
- Keep stubs compileable; placeholders may fail until the implementation step completes.
- Do not implement production behavior in this step beyond minimal compile support needed for the tests.
- If the request changes commands, public TypeScript contracts, README behavior, or workflow examples, include contract test stubs too.`,
		},
		{
			id: "implement-feature",
			title: "Implement feature and satisfy tests",
			model,
			prompt: `Using the prior research and plan, implement this feature request and complete/fill in the unit test stubs:
{input}

Requirements:
- Implement real logic in the appropriate core module before touching thin command/extension wiring.
- Fill in the unit test stubs with meaningful assertions; do not delete coverage unless it is obsolete and replaced.
- Keep CLI command behavior, README documentation, workflow examples, and TypeScript contracts in sync when the requested feature affects them.
- Run and fix the test suite until all tests pass and coverage is at least 85%.
- Address any feedback from failed verification or review checks before finishing.`,
			checks: [
				{
					type: "deterministic",
					id: "tests-and-coverage",
					name: "All tests pass with >=85% coverage",
					command: "npm run check && npx vitest run --coverage",
					timeoutMs: 1_800_000,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-correctness-contracts",
			title: "Review correctness and contracts",
			model,
			// Run each specialist review independently when a subagent backend is available.
			delegation: "auto",
			onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
			prompt: `Review the changes made for this feature request:
{input}

Focus only on correctness and contracts.

Requirements:
- Verify the implementation satisfies the requested behavior, acceptance criteria, edge cases, and failure cases.
- Check public TypeScript contracts, command behavior, workflow schema compatibility, and architecture boundaries.
- Treat correctness regressions, broken contracts, data loss, architecture violations, and incomplete required behavior as blocking.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
			checks: [
				{
					type: "agent",
					id: "correctness-blockers",
					name: "No blocking correctness or contract findings",
					prompt: `Evaluate the correctness and contracts review for this feature request:
{input}

Review output:
{outputs.review-correctness-contracts}

Pass only if the review found no blocking correctness, contract, architecture, or required-behavior issues.
Fail if the review found any blocking finding requiring remediation before shipping.`,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-security-privacy",
			title: "Review security and privacy",
			model,
			delegation: "auto",
			onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
			prompt: `Review the changes made for this feature request:
{input}

Focus only on security and privacy.

Requirements:
- Look for unsafe shell execution, command injection, path traversal, unsafe file-system access, secret leakage, untrusted workflow input handling, and environment variable exposure.
- Check whether new logs, prompts, errors, docs, tests, or command output could expose private data or credentials.
- Treat exploitable input handling, secret/privacy leakage, unsafe command construction, and destructive file operations as blocking.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
			checks: [
				{
					type: "agent",
					id: "security-blockers",
					name: "No blocking security or privacy findings",
					prompt: `Evaluate the security and privacy review for this feature request:
{input}

Review output:
{outputs.review-security-privacy}

Pass only if the review found no blocking security, privacy, unsafe input-handling, or destructive-operation issues.
Fail if the review found any blocking finding requiring remediation before shipping.`,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-performance-reliability",
			title: "Review performance and reliability",
			model,
			delegation: "auto",
			onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
			prompt: `Review the changes made for this feature request:
{input}

Focus only on performance and reliability.

Requirements:
- Look for inefficient file scans, excessive subprocess work, unbounded loops, weak timeout handling, flaky async behavior, race conditions, resource leaks, and large-repo scalability problems.
- Check retry behavior, concurrency safety, deterministic execution, and failure-mode handling.
- Treat runaway work, flaky or nondeterministic behavior, resource leaks, timeout hazards, and reliability regressions as blocking.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
			checks: [
				{
					type: "agent",
					id: "performance-blockers",
					name: "No blocking performance or reliability findings",
					prompt: `Evaluate the performance and reliability review for this feature request:
{input}

Review output:
{outputs.review-performance-reliability}

Pass only if the review found no blocking performance, reliability, determinism, timeout, race, or resource-leak issues.
Fail if the review found any blocking finding requiring remediation before shipping.`,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-tests-maintainability-docs",
			title: "Review tests, maintainability, and docs",
			model,
			delegation: "auto",
			onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
			prompt: `Review the changes made for this feature request:
{input}

Focus only on tests, maintainability, and documentation.

Requirements:
- Check Vitest coverage quality, meaningful assertions, edge/failure coverage, contract tests, and whether verification should be rerun.
- Check readability, repository conventions, TypeScript style, import style, naming, and whether the design is easy to maintain.
- Check that README, skills, examples, and command documentation stay aligned when behavior or public contracts change.
- Treat missing required tests, misleading documentation, convention violations that cause maintenance risk, and evidence of stale verification as blocking.
- Do not modify production code, tests, or docs/ISSUE.md; this specialist review should report findings only.
- Classify each finding as blocking or non-blocking with enough detail for remediation.
- If you find no issues in this focus area, state that explicitly.`,
			checks: [
				{
					type: "agent",
					id: "tests-maintainability-docs-blockers",
					name: "No blocking test, maintainability, or docs findings",
					prompt: `Evaluate the tests, maintainability, and docs review for this feature request:
{input}

Review output:
{outputs.review-tests-maintainability-docs}

Pass only if the review found no blocking test coverage, maintainability, convention, stale-verification, or documentation issues.
Fail if the review found any blocking finding requiring remediation before shipping.`,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "aggregate-review",
			title: "Aggregate reviews and record non-blockers",
			model,
			delegation: "auto",
			prompt: `Aggregate the specialist reviews for this feature request:
{input}

Correctness and contracts review:
{outputs.review-correctness-contracts}

Security and privacy review:
{outputs.review-security-privacy}

Performance and reliability review:
{outputs.review-performance-reliability}

Tests, maintainability, and docs review:
{outputs.review-tests-maintainability-docs}

Requirements:
- Synthesize and de-duplicate all specialist findings.
- Treat correctness regressions, broken contracts, missing required tests, failing verification, data loss, security/privacy issues, architecture violations, runaway work, and reliability regressions as blocking.
- If any blocking issues remain, report them clearly with the originating reviewer, affected files or behavior, and remediation guidance; do not fix the code in this step.
- If you find only non-blocking issues, append them to docs/ISSUE.md using that file's existing style and avoid duplicate entries.
- If you find no issues, state that explicitly.
- End with a concise final decision: either "blocking findings remain", "only non-blocking issues recorded", or "no review issues found".`,
			checks: [
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

Pass only if all of the following are true:
- The specialist reviews and aggregation found no blocking issues that require remediation before shipping.
- Any non-blocking issues discovered during review were added to docs/ISSUE.md.
- The implementation still satisfies the feature request and repository conventions.

Fail if there are unresolved blocking findings, missing required issue documentation for non-blockers, contradictory reviewer conclusions that need human or implementation follow-up, or evidence that tests/coverage should be rerun.`,
					onFail: { goto: "implement-feature", maxLoops: 10, onExhausted: "stop", feedback: true },
				},
			],
		},
	],
});
