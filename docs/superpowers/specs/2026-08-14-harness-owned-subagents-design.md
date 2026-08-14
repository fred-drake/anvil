# Harness-Owned Subagents Design

## Summary

Anvil will stop implementing subagent orchestration. Workflow authors will request subagents directly in step and agent-check prompts, and the active harness's installed skills or plugins will determine how to select, launch, await, and collect results from those subagents.

Anvil will remain responsible for workflow sequencing, output capture, deterministic checks, agent-verdict gates, retries, checkpoints, and reports. It will not detect, select, launch, monitor, or verify subagents.

## Goals

- Remove Anvil's Herdr- and cmux-specific subagent logic.
- Make subagent behavior follow the harness's native skills and plugins.
- Reduce Anvil's public workflow schema and runtime responsibilities.
- Preserve Anvil's deterministic workflow and gate behavior.
- Give existing workflows explicit migration errors rather than silently changing their meaning.

## Non-goals

- Defining a generic subagent API for harnesses.
- Verifying that the harness actually delegated work.
- Enforcing child-session isolation, model selection, timeout, cancellation, or verdict provenance.
- Translating old backend-specific declarations into new prompt text automatically.
- Adding special cross-turn waiting or result-transport logic for harness subagents.

## Architectural Boundary

Anvil owns workflow orchestration; the harness owns agent orchestration.

A workflow step is always sent through Anvil's normal main-harness instruction path. If its prompt says to use subagents, the harness interprets that request using its configured skills or plugins. Anvil does not add standardized delegation wording and does not inspect whether delegation occurred.

Agent checks follow the same boundary. Anvil supplies the evaluation criteria and exact `anvil_verdict` instructions. A check prompt may request a fresh review subagent, but the harness decides how to perform that request and how the final verdict tool call is produced.

## Public Contract Changes

Remove these public types:

- `WorkflowSubagentBackend`
- `WorkflowDelegation`
- `AgentReviewMode`

Remove these workflow fields:

- `WorkflowDefinition.defaults.delegation`
- `WorkflowDefinition.defaults.agent`
- `WorkflowDefinition.defaults.subagentTimeoutMs`
- `WorkflowStep.delegation`
- `WorkflowStep.agent`
- `WorkflowStep.runInMain`
- `WorkflowStep.subagentTimeoutMs`
- `AgentCheck.agent`
- `AgentCheck.review`
- `AgentCheck.reviewFallback`

Existing model-selection fields remain. They configure the main harness turn. Any child model or thinking selection is controlled by the harness's subagent skill or plugin.

Validation must reject each removed field with migration guidance. Removed fields must not be silently accepted or ignored.

## Runtime Changes

All steps use the existing main-session instruction flow:

1. Anvil renders the step prompt and retry feedback.
2. Anvil sends the instruction to the harness.
3. The harness executes the instruction, directly or through its own subagent facilities.
4. Anvil waits for the harness turn to complete.
5. Anvil evaluates configured checks and continues normal workflow sequencing.

`buildStepInstruction` will no longer resolve delegation or add instructions to delegate, select a skill, or prohibit delegation.

Agent checks continue to wait for `anvil_verdict`. Anvil does not use a separate review-subagent runner or review filesystem. If the prompt requests a review subagent, the harness is responsible for completing that request and ensuring that the matching verdict is submitted.

Existing `anvil_output` behavior remains unchanged. Main-session output is captured only when the harness calls `anvil_output`. A prompt that needs a child-derived output must instruct the harness to report it through that tool.

## Removed Runtime Components

Remove backend discovery, availability checks, and preflight failures. Remove the Herdr/cmux adapters, surface management, child bootstrap, process polling, session-file extraction, exit sidecars, isolated review filesystem, credential filtering, and review-child verdict transport when those components have no remaining non-subagent use.

Remove the corresponding `EngineHost` subagent methods, request/result types, extension child-session branch, environment variables, message rendering, evidence fields, and report fields.

Deletion should follow reference analysis rather than assuming every file under `src/subagent/` is unused.

## Failure Semantics

Subagent failures are owned by the harness. Anvil sees only the resulting harness turn and configured gate outcomes.

Consequences accepted by this design:

- Anvil cannot guarantee that required delegation happened.
- Anvil cannot guarantee fresh context, filesystem restrictions, credential isolation, or independent verdict provenance.
- Anvil cannot apply a child-specific timeout or reliably cancel a child.
- Anvil no longer records child backend, session file, exit code, or transport diagnostics.
- If a harness reports a subagent failure as a successful prose response, an ungated step may appear successful to Anvil.
- Asynchronous child-result delivery must be handled by the harness skill or plugin. Anvil will not remain open across additional turns specifically for subagent completion.

Workflows requiring strong correctness should use deterministic checks or agent-verdict gates. Documentation must distinguish Anvil-enforced checks from trusted harness-managed delegation.

## Migration

Backend-specific step delegation moves into prompt text.

Before:

```ts
{
	id: "implement",
	prompt: "Implement the change.",
	delegation: { subagent: "herdr" },
	subagentTimeoutMs: 1_800_000,
}
```

After:

```ts
{
	id: "implement",
	prompt: "Use subagents to implement the change.",
}
```

Independent review also moves into the check prompt.

Before:

```ts
{
	type: "agent",
	prompt: "Verify the implementation.",
	review: { subagent: "auto" },
	reviewFallback: "fail",
}
```

After:

```ts
{
	type: "agent",
	prompt:
		"Use a fresh review subagent to independently verify the implementation. " +
		"Report the final result with anvil_verdict.",
}
```

Validation errors should name the removed property and direct authors to put desired subagent behavior in the step or check prompt.

## Documentation Changes

Update the README, workflow-builder skill, demo workflow, examples, and schema comments to:

- remove Herdr/cmux setup and backend selection;
- remove declarative delegation and independent-review syntax;
- show prompt-level subagent requests;
- explain that harness skills/plugins define subagent behavior;
- state the accepted trust and failure semantics;
- preserve exact `anvil_verdict` guidance for agent checks;
- preserve `anvil_output` guidance for step outputs.

## Test Strategy

- Add validation tests for every removed field at defaults, step, and agent-check scopes.
- Verify validation messages include prompt-based migration guidance.
- Update workflow-contract tests for the smaller public schema.
- Verify step prompts containing `use subagents` pass through unchanged.
- Verify `buildStepInstruction` adds no delegation, skill-selection, or non-delegation policy.
- Verify all workflow steps use the normal harness instruction path.
- Verify agent checks still await the exact `anvil_verdict` regardless of prompt content.
- Remove backend preflight and command-completion expectations.
- Remove or rewrite history, report, checkpoint, and evidence tests that assert child-session metadata.
- Delete Herdr-, cmux-, runner-, child-session-, and isolated-review-specific tests when their production behavior is removed.
- Run `npm run check` after the complete migration.

## Success Criteria

- No production code detects or invokes Herdr or cmux.
- No public workflow field selects or configures subagents.
- A workflow can request subagents solely through ordinary prompt text.
- Harness subagent skills/plugins receive that prompt without Anvil imposing a competing mechanism.
- Removed workflow fields fail validation with actionable migration guidance.
- Workflow sequencing, deterministic checks, agent verdicts, outputs, retries, checkpoints, and reports continue to work without subagent-specific branches.
- Documentation accurately describes the new responsibility boundary and reduced guarantees.
