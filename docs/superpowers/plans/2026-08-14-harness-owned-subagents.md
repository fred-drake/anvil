# Harness-Owned Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Anvil's subagent orchestration so workflow prompts express subagent intent and the active harness's skills/plugins own all agent delegation.

**Architecture:** Anvil will send every step and agent check through its existing main-harness turn path. Backend-specific schema, Herdr/cmux launchers, independent-review children, and child-session evidence will be removed; validation will reject their former fields with prompt-migration guidance.

**Tech Stack:** TypeScript 5.9 strict ESM, Node.js 22+, Pi extension APIs, Vitest 4.

## Global Constraints

- Use tabs, double quotes, semicolons, and explicit `.ts` extensions in relative imports.
- Keep workflow sequencing, deterministic checks, `anvil_verdict`, `anvil_output`, retries, checkpoints, and reports working.
- Do not introduce a generic harness subagent API or standardized Anvil delegation prompt.
- Do not verify delegation, child isolation, child model selection, timeout, cancellation, or verdict provenance.
- Removed workflow fields must fail validation with actionable prompt-based migration guidance; never ignore or translate them silently.
- A prompt containing “use subagents” must pass through without Anvil choosing a backend or adding competing delegation policy.
- Use deterministic and fake-host tests; never invoke real Herdr, cmux, or harness subagents in the test suite.
- Do not add dependencies or generated artifacts.
- Run commands under Node.js 22 or newer.

---

## File Structure and Responsibility Map

**Core files retained and simplified**

- `src/types.ts` — public workflow contract without delegation/review-subagent fields.
- `src/validate.ts` — schema validation plus targeted migration errors for removed fields.
- `src/prompts.ts` — templating, plain step instructions, and main-harness agent-check verdict instructions.
- `src/engine.ts` — one main-harness execution path for normal and `forEach` steps.
- `src/gates.ts` — deterministic gates and main-harness `anvil_verdict` gates only.
- `src/index.ts` — Pi extension wiring without backend discovery, launchers, or child mode.
- `src/history.ts` / `src/ui.ts` — reports without child-session evidence.
- `src/errors.ts` — generic workflow abort/infrastructure errors only.

**Production files deleted**

- `src/subagent/child.ts`
- `src/subagent/cmux.ts`
- `src/subagent/exit.ts`
- `src/subagent/herdr.ts`
- `src/subagent/review-fs.ts`
- `src/subagent/runner.ts`
- `src/observable-result.ts`
- `src/review-identity.ts`

**Tests deleted because the production capability disappears**

- `test/herdr-subagent.test.ts`
- `test/subagent.test.ts`
- `test/observable-result.test.ts`

**Tests retained and rewritten**

- `test/validate.test.ts` — removed-field migration errors and backend-neutral fan-out validation.
- `test/engine.test.ts` — normal harness execution for prompt-requested subagents.
- `test/gates.test.ts` — prompt-requested reviews use the ordinary verdict path.
- `test/anvil-command.test.ts` — extension wiring without child mode or backend preflight.
- `test/history.test.ts` / `test/ui.test.ts` — workspace/check evidence without session files.
- `test/workflow-contract.test.ts` — public schema and documentation alignment.

**Workflow and documentation migration**

- `.pi/anvil/workflows/feature-forge.ts`
- `.pi/anvil/workflows/feature-forge-local.ts`
- `examples/workflows/demo.ts`
- `examples/workflows/fan-out.ts`
- `README.md`
- `skills/anvil-workflow-builder/SKILL.md`
- `docs/FEATURE.md`
- `docs/features/05-dry-run-plan.md`
- `docs/features/07-per-item-fanout.md`
- `docs/features/08-lifecycle-hooks.md`
- `docs/features/09-workflow-timeout-budget.md`
- `docs/features/10-workflow-composition.md`
- `docs/features/shipped-step-outputs.md`

---

### Task 1: Reject Legacy Fields and Migrate Executable Workflows

**Files:**
- Modify: `src/validate.ts` (`DEFAULTS_KEYS`, `STEP_KEYS`, `AGENT_CHECK_KEYS`, `validateDefaults`, `validateStep`, `validateAgentCheck`, `validateKnownKeys`)
- Modify: `test/validate.test.ts`
- Modify: `.pi/anvil/workflows/feature-forge.ts`
- Modify: `.pi/anvil/workflows/feature-forge-local.ts`
- Modify: `examples/workflows/demo.ts`
- Modify: `examples/workflows/fan-out.ts`
- Modify: `test/workflow-contract.test.ts` dogfood/example assertions only

**Interfaces:**
- Consumes: existing `validateWorkflow(value: unknown): ValidationResult`.
- Produces: validation errors of the form `<path>.<field> was removed; describe desired subagent behavior directly in the step or agent-check prompt`.
- Produces: executable workflows containing no removed delegation/review fields.

- [ ] **Step 1: Replace acceptance tests with failing migration tests**

In `test/validate.test.ts`, delete tests that accept `delegation`, backend selection, independent `review`, and `reviewFallback`. Add a table-driven test covering every removed field and both relevant scopes:

```ts
it.each([
	["workflow.defaults.delegation", { defaults: { delegation: "auto" } }],
	["workflow.defaults.agent", { defaults: { agent: "implementer" } }],
	["workflow.defaults.subagentTimeoutMs", { defaults: { subagentTimeoutMs: 1_000 } }],
	["workflow.steps[0].delegation", { steps: [{ id: "one", prompt: "a", delegation: { subagent: "cmux" } }] }],
	["workflow.steps[0].agent", { steps: [{ id: "one", prompt: "a", agent: "reviewer" }] }],
	["workflow.steps[0].runInMain", { steps: [{ id: "one", prompt: "a", runInMain: true }] }],
	["workflow.steps[0].subagentTimeoutMs", { steps: [{ id: "one", prompt: "a", subagentTimeoutMs: 1_000 }] }],
	["workflow.steps[0].checks[0].agent", {
		steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", agent: "reviewer" }] }],
	}],
	["workflow.steps[0].checks[0].review", {
		steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", review: { subagent: "auto" } }] }],
	}],
	["workflow.steps[0].checks[0].reviewFallback", {
		steps: [{ id: "one", prompt: "a", checks: [{ type: "agent", prompt: "review", reviewFallback: "fail" }] }],
	}],
])("rejects removed field %s with prompt migration guidance", (path, patch) => {
	const workflow = {
		name: "removed-subagent-field",
		steps: [{ id: "one", prompt: "a" }],
		...patch,
	};
	const result = validateWorkflow(workflow);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.errors).toContain(
			`${path} was removed; describe desired subagent behavior directly in the step or agent-check prompt`,
		);
	}
});
```

Build separate complete workflow objects where shallow spreading would otherwise replace required fields. Also replace the old “concurrency requires subagent delegation” tests with:

```ts
it("accepts concurrency greater than one without inspecting delegation", () => {
	const workflow = {
		name: "parallel-request",
		steps: [{ id: "items", prompt: "Use subagents for {item}", forEach: { items: () => ["a"], concurrency: 4 } }],
	};
	expect(validateWorkflow(workflow)).toEqual({ ok: true, workflow });
});
```

- [ ] **Step 2: Run validation tests and verify the new expectations fail**

Run: `npx vitest run test/validate.test.ts`

Expected: FAIL because removed fields are still accepted/validated with backend-specific messages and `concurrency > 1` still inspects delegation.

- [ ] **Step 3: Implement removed-field diagnostics**

In `src/validate.ts`:

1. Remove the legacy keys from `DEFAULTS_KEYS`, `STEP_KEYS`, and `AGENT_CHECK_KEYS`.
2. Delete `AGENT_REVIEW_KEYS`, `validateAgentReview`, and `validateDelegation`.
3. Delete field-specific validation branches for all removed fields.
4. Delete the `workflowDefaults` parameter from `validateStep`; it is no longer needed for delegation-aware concurrency validation.
5. Delete the `concurrency > 1 requires subagent delegation` block while retaining positive-integer validation.
6. Teach `validateKnownKeys` to distinguish removed subagent fields from ordinary unknown keys:

```ts
const REMOVED_SUBAGENT_FIELDS = new Set([
	"delegation",
	"agent",
	"runInMain",
	"subagentTimeoutMs",
	"review",
	"reviewFallback",
]);

function validateKnownKeys(record: Record<string, unknown>, path: string, allowed: Set<string>, errors: string[]): void {
	for (const key of Object.keys(record)) {
		if (allowed.has(key)) continue;
		const fieldPath = `${path}.${key}`;
		errors.push(
			REMOVED_SUBAGENT_FIELDS.has(key)
				? `${fieldPath} was removed; describe desired subagent behavior directly in the step or agent-check prompt`
				: `${fieldPath} is not recognized`,
		);
	}
}
```

Keep ordinary unknown-key behavior unchanged.

- [ ] **Step 4: Migrate project and example workflows**

Apply prompt-only migration without changing each workflow's business task:

- Remove every `defaults.delegation`, step `delegation`, `runInMain`, `review`, and `reviewFallback` field.
- Where a step previously declared subagent/auto delegation, prepend a concise instruction such as `"Use subagents where appropriate. "` or `"Use a fresh review subagent to ..."` to that step/check prompt.
- Where `runInMain: true` expressed a deliberate prohibition, prepend `"Do this directly in the main agent; do not delegate it. "`.
- In `examples/workflows/fan-out.ts`, change the `stubs` prompt to begin `"Use subagents to write unit test stubs for {item} ..."` and update comments/description from guaranteed fresh sessions to harness-managed delegation.
- In `examples/workflows/demo.ts`, move independent-review intent into the agent-check prompt and include the existing requirement to report through `anvil_verdict`.

Update only the dogfood/example assertions in `test/workflow-contract.test.ts` so they require the new prompt phrases and reject removed fields in those files.

- [ ] **Step 5: Run focused validation and workflow-contract tests**

Run: `npx vitest run test/validate.test.ts test/workflow-contract.test.ts`

Expected: PASS. The old public-type and documentation assertions still pass at this intermediate point because Task 1 changes validation and executable workflows only; Task 5 replaces those assertions when it removes the public types and rewrites the docs.

- [ ] **Step 6: Commit**

```bash
git add src/validate.ts test/validate.test.ts test/workflow-contract.test.ts \
  .pi/anvil/workflows/feature-forge.ts .pi/anvil/workflows/feature-forge-local.ts \
  examples/workflows/demo.ts examples/workflows/fan-out.ts
git commit -m "feat: reject backend-specific subagent fields"
```

---

### Task 2: Route Every Step Through the Main Harness

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/engine.ts`
- Modify: `src/index.ts`
- Modify: `test/engine.test.ts`
- Modify: `test/anvil-command.test.ts`
- Modify: `test/workflow-contract.test.ts`

**Interfaces:**
- Consumes: `EngineHost.sendInstruction`, `EngineHost.waitForTurnComplete`, `beginStepOutputCapture`, and `endStepOutputCapture`.
- Produces: `buildStepInstruction(options): Promise<string>` containing only the Anvil header, `Task:` marker, rendered workflow prompt, and retry feedback.
- Produces: one execution path in `runWorkflow` and `executeForEachItem`, with no `runSubagent` host method.

- [ ] **Step 1: Write failing prompt and engine tests**

In `test/engine.test.ts`, add a fake-host test proving prompt-level subagent intent uses the ordinary turn path:

```ts
it("passes subagent intent through the normal harness turn", async () => {
	const host = new FakeHost();
	const summary = await runWorkflow({
		workflow: defineWorkflow({
			name: "harness-subagents",
			steps: [{ id: "implement", prompt: "Use subagents to implement {input}." }],
		}),
		input: "the change",
		cwd: "/tmp/project",
		host,
	});

	expect(summary.state).toBe("succeeded");
	expect(host.instructions).toEqual([
		expect.stringContaining("Task:\nUse subagents to implement the change."),
	]);
});
```

Add a prompt assertion that the instruction does **not** contain Anvil-authored phrases such as `Choose whether to use a subagent`, `Do not delegate`, `using skill`, `cmux`, or `herdr`.

Replace the former `runSubagent`-based `forEach` test with a test that records one normal harness instruction per item and still verifies per-item retries/model escalation.

- [ ] **Step 2: Run focused engine tests and verify failure**

Run: `npx vitest run test/engine.test.ts -t "passes subagent intent|forEach items"`

Expected: FAIL because default delegation currently injects policy and backend-detected steps can use `host.runSubagent`.

- [ ] **Step 3: Simplify step prompt construction**

In `src/prompts.ts`:

- Remove `buildSubagentStepTask`, `buildSubagentResultMessage`, `ResolvedStepDelegation`, `resolveStepDelegation`, `workflowSubagentBackends`, and `workflowUsesSubagentDelegation`.
- Retain `detectAutoSubagentBackend` and `resolveReviewSubagentBackend` temporarily because the independent-review path still uses them until Task 3.
- Retain templating, command rendering, feedback, loop counting, and agent-check instructions.
- Replace `buildStepInstruction`'s delegation switch with:

```ts
export async function buildStepInstruction(options: StepInstructionOptions): Promise<string> {
	const renderedPrompt = await renderTemplatable(options.step.prompt, options.ctx);
	const task = appendFeedback(renderedPrompt, options.feedback);
	const title = options.step.title ?? options.step.id;
	const header = `[anvil] Workflow "${options.workflow.name}" — step ${options.stepIndex + 1}/${options.stepCount}: ${title}`;
	return `${header}\n\nTask:\n${task}`;
}
```

- [ ] **Step 4: Remove the engine's delegated-step branch**

In `src/engine.ts`:

- Remove `SubagentStepRunRequest`, `SubagentStepRunResult`, and `EngineHost.runSubagent`.
- Remove subagent imports and `delegatedStepFailure`.
- In the normal step path, always apply `resolveStepModelSelection` to the main harness when model overrides exist, build the ordinary instruction, checkpoint `step_start`, run `runMainSessionAttempt`, and store only explicit `anvil_output` capture.
- Remove the post-subagent model-reset branch; the selected model is already applied before the ordinary turn.
- Replace `runItemDelegation` with `runItemAttempt` that always follows this shape:

```ts
async function runItemAttempt(
	args: ForEachItemArgs & { ctx: WorkflowContext },
): Promise<{ ok: true; summary: string } | { ok: false; reason: string }> {
	const { options, step, stepIndex, ctx, itemIndex, itemCount } = args;
	const feedbackKey = `${step.id}#${itemIndex}`;
	if (args.workflowHasModelSelectionOverrides) {
		args.markRestoreModelSelection();
		await options.host.applyStepModelSelection?.(resolveStepModelSelection(step, getCurrentLoopCount(ctx)));
	}
	const instruction = await buildStepInstruction({
		workflow: options.workflow,
		step,
		ctx,
		stepIndex,
		stepCount: options.workflow.steps.length,
		feedback: args.feedbackByStep.get(feedbackKey),
	});
	args.feedbackByStep.delete(feedbackKey);
	args.checkpoint({ phase: "step_start", stepId: step.id, stepIndex, itemIndex, itemCount });
	const summary = await runMainSessionAttempt(options, step.id, instruction);
	return { ok: true, summary: summary ?? "" };
}
```

- Keep `forEach` sequential-degradation warnings and per-item retry keys unchanged.

- [ ] **Step 5: Remove step-launch wiring from the extension**

In `src/index.ts`:

- Stop creating/passing `createCmuxSubagentRunner`.
- Remove `runSubagent` from the object returned by `createEngineHost`.
- Remove subagent-result message injection.
- Remove step-delegation backend preflight from run and resume.
- Keep review-child wiring temporarily; Task 3 removes it.
- Remove step-only imports while retaining review-only imports needed until Task 3.

Update `test/anvil-command.test.ts` to delete step-backend preflight expectations while retaining independent-review tests until Task 3.

In `test/workflow-contract.test.ts`, remove the `workflowSubagentBackends` import, auto-detection tests, environment helper, and assertions that the engine resolves step backends. Keep the legacy public-type assertions until Task 5 removes the types.

- [ ] **Step 6: Rewrite obsolete engine tests**

Delete tests whose only behavior is backend selection, backend availability, step launcher transport, child session summary capture, or child-specific model propagation. Preserve and adapt tests for:

- main-session model and retry model selection;
- `forEach` per-item model escalation;
- explicit `anvil_output` capture;
- gate retries and feedback;
- abort behavior of ordinary turns.

Do not weaken assertions for deterministic checks, freshness, checkpoints, or retries.

- [ ] **Step 7: Run engine and command tests**

Run: `npx vitest run test/engine.test.ts test/anvil-command.test.ts test/workflow-contract.test.ts`

Expected: PASS with no real backend calls.

- [ ] **Step 8: Commit**

```bash
git add src/prompts.ts src/engine.ts src/index.ts test/engine.test.ts \
  test/anvil-command.test.ts test/workflow-contract.test.ts
git commit -m "refactor: route steps through the harness"
```

---

### Task 3: Remove Independent Review Launchers and Backend Code

**Files:**
- Modify: `src/gates.ts`
- Modify: `src/prompts.ts`
- Modify: `src/engine.ts`
- Modify: `src/index.ts`
- Modify: `src/errors.ts`
- Modify: `test/gates.test.ts`
- Modify: `test/engine.test.ts`
- Modify: `test/anvil-command.test.ts`
- Delete: `src/subagent/child.ts`
- Delete: `src/subagent/cmux.ts`
- Delete: `src/subagent/exit.ts`
- Delete: `src/subagent/herdr.ts`
- Delete: `src/subagent/review-fs.ts`
- Delete: `src/subagent/runner.ts`
- Delete: `src/review-identity.ts`
- Delete: `src/observable-result.ts`
- Delete: `test/herdr-subagent.test.ts`
- Delete: `test/subagent.test.ts`
- Delete: `test/observable-result.test.ts`

**Interfaces:**
- Consumes: `EngineHost.awaitVerdict(checkId, timeoutMs, signal)` and normal turn methods.
- Produces: `executeAgentCheck` with only main-harness verdict flow.
- Produces: no production imports or environment branches for Herdr, cmux, or `PI_ANVIL_SUBAGENT_SESSION`.

- [ ] **Step 1: Write a failing harness-managed review gate test**

In `test/gates.test.ts`, retain the normal verdict-bus fixture and add:

```ts
it("passes prompt-requested review subagents through the normal verdict path", async () => {
	const host = new GateHost();
	host.verdict = { checkId: "ignored", pass: true, reason: "independent review passed" };
	const definition = workflow();
	const result = await executeAgentCheck({
		host,
		workflow: definition,
		step: definition.steps[0]!,
		check: {
			type: "agent",
			prompt: "Use a fresh review subagent to verify the implementation.",
		},
		ctx: ctx(),
		checkId: "run:step:review",
	});

	expect(host.instructions[0]).toContain("Use a fresh review subagent");
	expect(result).toMatchObject({ pass: true, reason: "independent review passed" });
});
```

- [ ] **Step 2: Run the focused gate test**

Run: `npx vitest run test/gates.test.ts -t "prompt-requested review subagents"`

Expected: PASS through today's main path if no `review` field is present. This characterization test protects the behavior while the dedicated branch is deleted.

- [ ] **Step 3: Simplify agent-check prompts and gates**

In `src/prompts.ts`:

- Remove `buildIndependentReviewTask`, independent-review identity exports, observable-result imports, `detectAutoSubagentBackend`, `resolveReviewSubagentBackend`, and the `check.agent` delegate line.
- Keep `buildAgentCheckInstruction` rendering the criteria exactly and appending the exact `anvil_verdict` contract.

In `src/gates.ts`:

- Remove all review-child imports and `DEFAULT_INDEPENDENT_REVIEW_TIMEOUT_MS`.
- Remove the `if (args.check.review)` branch, unavailable-review helpers, review request model/thinking/run-id arguments, and `GateResult.sessionFile` once engine references are removed.
- Keep the existing two-turn verdict/reprompt behavior unchanged:

```ts
const firstWait = startVerdictWait(args);
const instruction = await buildAgentCheckInstruction({
	workflow: args.workflow,
	step: args.step,
	check: args.check,
	ctx: args.ctx,
	checkId: args.checkId,
});
args.host.sendInstruction(instruction);
```

Do not alter deterministic-check behavior or verdict timeout defaults.

- [ ] **Step 4: Remove review-specific engine plumbing**

In `src/engine.ts`:

- Remove `ReviewSubagentRunRequest`, `ReviewSubagentRunResult`, `EngineHost.runReviewSubagent`, and `EngineHost.isReviewSubagentAvailable`.
- Remove observable-result values and arguments from normal and `forEach` checks.
- Remove `check.review` infrastructure-error catch blocks.
- Remove `runId`, model, thinking, and observable-result arguments that existed only for review-child launch from `executeCheck`/`executeAgentCheck` calls.
- Remove the now-unused `infrastructureFailure` and `sanitizeInfrastructureDiagnostic` helpers and their imports; retain generic abort/error-to-summary handling.
- Keep workspace-freshness enforcement for successful agent verdicts.

- [ ] **Step 5: Remove extension child mode and launch wiring**

In `src/index.ts`:

- Remove all imports from `src/subagent/*`.
- Remove the `PI_ANVIL_SUBAGENT_SESSION` early-return branch.
- Stop constructing review runners and remove them from `createEngineHost` parameters.
- Remove `isReviewSubagentAvailable` and `runReviewSubagent` from the host object.
- Remove backend preflight helpers and remove `preflightSubagentBackends` from `__testing__`.

In `src/errors.ts`, remove `ReviewSubagentUnavailableError` and `isReviewSubagentUnavailableError`; retain abort and generic infrastructure errors.

- [ ] **Step 6: Delete backend and isolation implementation files**

Delete the listed `src/subagent/*.ts`, `src/review-identity.ts`, and `src/observable-result.ts` files. Then delete their dedicated test files.

Before deletion, verify no retained source imports them:

Run: `rg 'subagent/|observable-result|review-identity|ReviewSubagent' src --glob '*.ts'`

Expected after edits: no matches.

- [ ] **Step 7: Rewrite retained review tests**

In `test/gates.test.ts`, remove dedicated-review launch, sidecar, identity-bounding, unavailable-backend, and isolated reviewer-task tests. Preserve tests for:

- exact check id;
- verdict before/after turn completion;
- one reprompt when prose arrives without a verdict;
- no-verdict failure;
- abort and timeout;
- deterministic gates.

In `test/engine.test.ts`, remove review-child observable-boundary and transport tests. Add/retain one end-to-end check whose prompt asks the harness to use a fresh review subagent and whose fake host submits `anvil_verdict` normally.

In `test/anvil-command.test.ts`, remove subagent child-mode, review preflight, isolated environment, and review-tool registration blocks. Preserve ordinary `anvil_verdict`, `anvil_output`, command, history, status, resume, and watch tests.

- [ ] **Step 8: Run focused tests and typecheck**

Run: `npm run typecheck && npx vitest run test/gates.test.ts test/engine.test.ts test/anvil-command.test.ts`

Expected: PASS, and TypeScript reports no imports of deleted modules.

- [ ] **Step 9: Commit**

```bash
git add -A src test
git commit -m "refactor: remove subagent backend runtime"
```

---

### Task 4: Remove Child-Session Evidence From Checkpoints and Reports

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/history.ts`
- Modify: `src/ui.ts`
- Modify: `test/history.test.ts`
- Modify: `test/ui.test.ts`
- Modify: `test/engine.test.ts`

**Interfaces:**
- Produces: `RunEvidence` containing only workspace snapshots.
- Produces: `AnvilCheckpoint` without `sessionFile` or `sessionFiles`.
- Produces: `RunReport` without `subagentSessions`.

- [ ] **Step 1: Write failing report-contract tests**

Update `test/history.test.ts` so a checkpoint containing hostile legacy `sessionFile`/`sessionFiles` values is safely ignored rather than copied into the typed checkpoint/report. Assert:

```ts
expect(toAnvilCheckpoint(entry)).not.toHaveProperty("sessionFile");
expect(buildRunReports([entry])[0]).not.toHaveProperty("subagentSessions");
```

Update `test/ui.test.ts` so summary/report rendering contains workspace and check evidence but never a `Subagent sessions` section.

- [ ] **Step 2: Run history/UI tests and verify failure**

Run: `npx vitest run test/history.test.ts test/ui.test.ts`

Expected: FAIL because the current parser and renderers retain session paths.

- [ ] **Step 3: Remove evidence fields and folding logic**

In `src/engine.ts`:

- Remove `subagentSessions` from `RunEvidence` and initialize evidence as `{}` or with workspace fields only.
- Remove `sessionFile`/`sessionFiles` from `AnvilCheckpoint`.
- Remove session fields from checkpoint calls and final run-end checkpoints.

In `src/history.ts`:

- Remove `RunReport.subagentSessions`.
- Stop parsing `sessionFile`/`sessionFiles` in `toAnvilCheckpoint`.
- Remove `addSession`, path-count truncation for sessions, and `buildRunHistory`'s session-field omission destructure.
- Keep workspace path sanitization and all general credential/diagnostic redaction.

In `src/ui.ts`:

- Stop supplying a default `subagentSessions` array.
- Remove summary and detailed-report session sections.
- Retain workspace evidence, changed files, failure reasons, and truncation notices.

- [ ] **Step 4: Update engine evidence tests**

Delete only assertions for child session paths. Retain assertions for:

- `workspaceStart`, `lastVerification`, and `workspaceEnd`;
- deterministic check command/timeout evidence;
- bounded checkpoint output;
- redacted infrastructure diagnostics unrelated to deleted child transport.

- [ ] **Step 5: Run evidence tests**

Run: `npx vitest run test/history.test.ts test/ui.test.ts test/engine.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/history.ts src/ui.ts test/engine.test.ts test/history.test.ts test/ui.test.ts
git commit -m "refactor: remove subagent session evidence"
```

---

### Task 5: Remove the Public Types and Align Documentation

**Files:**
- Modify: `src/types.ts`
- Modify: `test/workflow-contract.test.ts`
- Modify: `README.md`
- Modify: `skills/anvil-workflow-builder/SKILL.md`
- Modify: `docs/FEATURE.md`
- Modify: `docs/features/05-dry-run-plan.md`
- Modify: `docs/features/07-per-item-fanout.md`
- Modify: `docs/features/08-lifecycle-hooks.md`
- Modify: `docs/features/09-workflow-timeout-budget.md`
- Modify: `docs/features/10-workflow-composition.md`
- Modify: `docs/features/shipped-step-outputs.md`

**Interfaces:**
- Produces: `WorkflowDefinition`, `WorkflowStep`, and `AgentCheck` with no Anvil-owned delegation fields.
- Produces: workflow-authoring guidance that uses ordinary prompt text for all subagent requests.

- [ ] **Step 1: Invoke the writing-skills sub-skill**

Because this task edits `skills/anvil-workflow-builder/SKILL.md`, read and follow `superpowers:writing-skills` before editing the skill. Treat the skill as user-facing product behavior, not incidental documentation.

- [ ] **Step 2: Write failing public-contract assertions**

Replace backend/review contract tests in `test/workflow-contract.test.ts` with assertions such as:

```ts
it("keeps subagent orchestration out of the public workflow contract", () => {
	const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
	for (const removed of [
		"WorkflowSubagentBackend",
		"WorkflowDelegation",
		"AgentReviewMode",
		"delegation?: WorkflowDelegation",
		"agent?: string",
		"review?: AgentReviewMode",
		"subagentTimeoutMs",
		"reviewFallback",
		"runInMain",
	]) {
		expect(types).not.toContain(removed);
	}
});

it("documents prompt-owned subagent intent", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const skill = readFileSync(new URL("../skills/anvil-workflow-builder/SKILL.md", import.meta.url), "utf8");
	for (const document of [readme, skill]) {
		expect(document).toMatch(/prompt[^\n]+use subagents|use subagents[^\n]+prompt/i);
		expect(document).toMatch(/harness[^\n]+skills|skills[^\n]+harness/i);
		expect(document).not.toContain('delegation: { subagent: "cmux" }');
		expect(document).not.toContain('review: { subagent: "auto" }');
	}
});
```

Add assertions that `examples/workflows/demo.ts`, `examples/workflows/fan-out.ts`, and both `.pi/anvil/workflows/feature-forge*.ts` contain no removed fields.

- [ ] **Step 3: Run the contract tests and verify failure**

Run: `npx vitest run test/workflow-contract.test.ts`

Expected: FAIL because legacy types and documentation remain.

- [ ] **Step 4: Remove legacy public types and fields**

In `src/types.ts`:

- Delete `WorkflowSubagentBackend`, `WorkflowDelegation`, and `AgentReviewMode`.
- Remove `agent`, `review`, and `reviewFallback` from `AgentCheck`.
- Remove `delegation`, `subagentTimeoutMs`, `agent`, and `runInMain` from `WorkflowStep`.
- Remove `delegation`, `subagentTimeoutMs`, and `agent` from `WorkflowDefinition.defaults`.
- Update `AgentCheck.timeoutMs` documentation to say it defaults to `300_000` without an independent-review exception.
- Leave model/thinking fields documented as main-harness settings.

- [ ] **Step 5: Rewrite README authoring guidance**

Replace backend/delegation and independent-review sections with a concise responsibility boundary:

```md
### Harness-managed subagents

Anvil does not select or launch subagents. To use them, say so in the step or agent-check prompt, for example: `Use subagents to implement this change.` The active harness's installed skills and plugins decide how delegation works.

Anvil cannot verify that delegation occurred or enforce child isolation, model choice, timeout, cancellation, or verdict provenance. Keep deterministic or agent gates when correctness matters. Agent checks must still submit the exact `anvil_verdict`; steps that expose text to later steps must still call `anvil_output` or use `outputFrom`.
```

Also update:

- fan-out wording from guaranteed fresh child sessions to one harness turn per item, whose prompt may request subagents;
- retry-model wording so it applies to the main harness turn, not automatically to children;
- failure semantics so they no longer promise child launch/transport diagnostics;
- step-output wording so prompt-requested child results are captured only when the harness calls `anvil_output`.

- [ ] **Step 6: Rewrite workflow-builder guidance**

In `skills/anvil-workflow-builder/SKILL.md`:

- Remove the delegation-selection questionnaire/default and all Herdr/cmux environment detection.
- Ask whether any step/check prompt should request subagents only when the user expresses that intent.
- Encode the request directly in the prompt text; do not emit a schema field.
- Explain that harness skills/plugins own agent selection and lifecycle.
- Preserve exact `anvil_verdict`, `anvil_output`, templating, retry, `forEach`, and workflow-path rules.
- Replace independent-review schema guidance with prompt wording such as `Use a fresh review subagent to independently verify ...` while explicitly retaining the verdict tool requirement.

- [ ] **Step 7: Align backlog and historical feature records**

Make targeted updates rather than rewriting unrelated designs:

- `docs/FEATURE.md`: remove delegation resolution from `/anvil plan`; describe fan-out as deterministic per-item turns whose prompts may ask the harness for subagents; remove `subagentTimeoutMs` from timeout grounding.
- `docs/features/05-dry-run-plan.md`: remove delegation/backend resolution from goals, output, tests, and risks.
- `docs/features/07-per-item-fanout.md`: add a prominent current-runtime note and revise claims that the engine guarantees fresh child sessions or that concurrency requires declarative subagent mode.
- `docs/features/08-lifecycle-hooks.md`: remove removed defaults fields from schema grounding.
- `docs/features/09-workflow-timeout-budget.md`: replace child poll/timeout references with ordinary harness-turn cancellation language.
- `docs/features/10-workflow-composition.md`: remove `runSubagent` from host capability lists and comparisons.
- `docs/features/shipped-step-outputs.md`: revise automatic child-summary capture to the surviving explicit `anvil_output`/`outputFrom` semantics.

Historical commit references may remain, but no document should present removed fields as currently supported.

- [ ] **Step 8: Run contract, validation, and documentation tests**

Run: `npm run typecheck && npx vitest run test/workflow-contract.test.ts test/validate.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts test/workflow-contract.test.ts README.md \
  skills/anvil-workflow-builder/SKILL.md docs/FEATURE.md docs/features \
  .pi/anvil/workflows examples/workflows
git commit -m "docs: move subagent control to harness prompts"
```

---

### Task 6: Audit References and Run Full Verification

**Files:**
- Modify only files identified by the audit; do not add unrelated refactors.
- Append a newly discovered non-blocking defect to `docs/ISSUE.md` only if the audit finds one that is outside this design's scope.

**Interfaces:**
- Produces: repository with no live backend-specific subagent code or schema.
- Produces: passing typecheck, tests, and coverage thresholds.

- [ ] **Step 1: Audit live source, tests, examples, and user documentation**

Run:

```bash
rg -n 'WorkflowSubagentBackend|WorkflowDelegation|AgentReviewMode|PI_ANVIL_SUBAGENT_SESSION|HERDR_ENV|CMUX_SHELL_INTEGRATION|runSubagent|runReviewSubagent|reviewFallback|subagentTimeoutMs|runInMain' \
  src test examples .pi README.md skills docs \
  --glob '!docs/superpowers/**'
```

Expected: no live references. Historical feature records may contain the word “subagent” but must not claim removed schema/backend support. Fix any stale live references surgically and rerun the audit.

- [ ] **Step 2: Verify deleted files and working-tree scope**

Run:

```bash
test ! -d src/subagent
test ! -e src/observable-result.ts
test ! -e src/review-identity.ts
test ! -e test/subagent.test.ts
test ! -e test/herdr-subagent.test.ts
test ! -e test/observable-result.test.ts
git status --short
```

Expected: deleted files are absent; status contains only intended implementation changes, if any remain uncommitted.

- [ ] **Step 3: Run the primary repository check**

Run: `npm run check`

Expected: TypeScript passes and all Vitest tests pass with zero failures.

- [ ] **Step 4: Run coverage verification**

Run: `npx vitest run --coverage`

Expected: PASS with at least 85% statements, branches, functions, and lines.

- [ ] **Step 5: Commit audit fixes if needed**

If Steps 1–4 required changes:

```bash
git add -A
git commit -m "chore: remove stale subagent references"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Perform final verification after the last commit**

Run:

```bash
npm run check
git status --short
```

Expected: checks pass and the working tree is clean.
