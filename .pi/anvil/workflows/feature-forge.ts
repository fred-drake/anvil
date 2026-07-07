import { defineWorkflow } from "anvil";

const model = "openai-codex/gpt-5.5:high";

export default defineWorkflow({
	name: "feature-forge",
	description: "Research-backed, test-first feature implementation with verification, coverage, review, and issue capture.",
	defaults: {
		delegation: { subagent: "cmux" },
		onFail: "stop",
		maxLoops: 3,
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
					onFail: { goto: "implement-feature", maxLoops: 3, onExhausted: "stop", feedback: true },
				},
			],
		},
		{
			id: "review-code",
			title: "Review code and record non-blockers",
			model,
			prompt: `Review the changes made for this feature request:
{input}

Requirements:
- Perform a code review focused on correctness, test quality, maintainability, architecture contracts, concurrency safety, and repository conventions.
- Treat correctness regressions, broken contracts, missing required tests, failing verification, data loss, security/privacy issues, and architecture violations as blocking.
- If you find blocking issues, leave clear review findings with enough detail for the implementation step to remediate them.
- If you find only non-blocking issues, append them to docs/ISSUE.md using that file's existing style.
- If you find no issues, state that explicitly.`,
			checks: [
				{
					type: "agent",
					id: "blocking-review",
					name: "No blocking review findings",
					prompt: `Evaluate the completed review for this feature request:
{input}

Pass only if all of the following are true:
- The code review found no blocking issues that require remediation before shipping.
- Any non-blocking issues discovered during review were added to docs/ISSUE.md.
- The implementation still satisfies the feature request and repository conventions.

Fail if there are unresolved blocking findings, missing required issue documentation for non-blockers, or evidence that tests/coverage should be rerun.`,
					onFail: { goto: "implement-feature", maxLoops: 3, onExhausted: "stop", feedback: true },
				},
			],
		},
	],
});
