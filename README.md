<p align="center">
  <img src="assets/anvil-logo.png" alt="Anvil logo" width="320">
</p>

# Anvil

A Pi extension that runs declarative TypeScript workflows with deterministic and agent-judged gates.

Anvil is for those Pi tasks where you keep thinking, “I want the agent to do this the same way every time, but I also want it to use judgment when a script cannot tell the whole story.” You can chain steps together, gate each step with hard pass/fail checks or agent-reviewed thumbs-up/thumbs-down checks, and keep the process moving without babysitting every turn.

## Features at a glance

- Build the workflow in your own words and Anvil will worry about how to properly build it.
- For each workflow step, set any number of gating checks that must pass. Checks can be deterministic, like a script or executable that returns exit code `0`, or non-deterministic, where a subagent evaluates the result and gives a 👍 or 👎 based on what it thinks should happen.
- Define subagent behavior based on how you have configured Pi. cmux and herdr compatibility come out of the box, you can choose a custom skill that you wrote for handling subagent processing, or no subagent at all if you wish.
- Optionally define the number of times a step has to be retried before bailing.
- Optionally define a different model and thinking level for each step, including retry-based upgrades.
- Pass captured text from earlier steps into later prompts and checks with `{outputs.<step-id>}`.
- Fan a step out over a list of items with `forEach`, running its prompt once per item (each in its own subagent session) so small local models get one bite-sized task at a time.

## Build workflows by talking to Pi

The intended way to create a workflow is to describe what you want in plain language and let the agent shape it into something Anvil can run. This extension includes an `anvil-workflow-builder` skill that guides that conversation, asks for missing details when it needs them, and handles the workflow structure for you.

Although it follows a typescript schema under the hood, the intention is to say what the workflow should do in your own words. If Anvil needs exact commands, gating behavior, model choices, or delegation preferences, it will ask.

Workflows live in:

- User: `~/.pi/agent/anvil/workflows/*.ts` (also `.js`/`.mjs`)
- Project: `.pi/anvil/workflows/*.ts` (project workflows win on name collisions)

⚠️ Workflow discovery for `/anvil list`, `/anvil validate`, `/anvil run`, and completions imports workflow modules, so their top-level code executes. Only use Anvil in trusted projects; opening an untrusted repo and touching `/anvil` can run project-controlled code.

## Commands

```text
/anvil list
/anvil validate <name>
/anvil run <name> <free-form task input>
/anvil history [name]
/anvil report [run-id-prefix]
/anvil resume <step> [retry-number]
/anvil abort
```

Use `/anvil list` to see available workflows, `/anvil validate` to check that one is ready, and `/anvil run` to start a workflow with whatever task input you want to give it.

Use `/anvil history [name]` to list recent runs in the current Pi session, optionally for one workflow. Use `/anvil report [run-id-prefix]` for the latest run or a detailed persisted artifact for one run: check commands and outcomes, timeouts, Git workspace snapshot, changed files, and subagent session paths. The final workflow summary links to the same report. Run reports are session-scoped because they read Anvil's append-only checkpoint entries.

Anvil captures a Git snapshot before the run, after every successful deterministic check, and after each agent approval. If an agent approval reports pass after the workspace changed since the most recent successful deterministic verification, Anvil fails that approval as stale. This prevents a review from approving code that is different from what was verified; workflows should rerun deterministic verification after intentional changes.

Use `/anvil resume` after a failed or aborted run to see a numbered step map, for example `1. Plan`, `2. Implement`, `3. Verify`. The map includes the prior run timestamp and failure reason, and marks the last started step as a suggested resume point when Anvil can infer one. Then run `/anvil resume <step> [retry-number]` with the one-based step number to restart from that workflow step using the original task input. Omit `retry-number` when no retry count is seeded (so `{loop}` starts at 0 for the resumed step); normal workflow retry policies still apply.

## Declarative subagents

Each workflow step can decide how much help it wants from another agent. By default, `delegation: "auto"` auto-detects your mux environment, using `HERDR_ENV=1` for herdr first, then `CMUX_SHELL_INTEGRATION=1` for cmux. Current supported environments are cmux and herdr. You can also force one of these two environments with `delegation: { subagent: "cmux" }` or `delegation: { subagent: "herdr" }`. Or if you prefer to use a specific skill that you've crafted that handles subagents, you can tell it to use that instead. Lastly, you can explicitly tell it to do not use subagents.

Mux subagents launch a normal interactive `pi` session directly in the spawned pane or tab, so you can watch the step work live instead of staring at a shell-script wrapper until it finishes. Anvil retries provider transport failures (such as a dropped model connection) and fails the step after three such failures within five minutes; ordinary non-zero child exits still fail immediately.

⚠️ It is advised to use subagents on any step that is non-trivial, because you run the risk of context pollution.

⚠️ While skills are supported, be aware that unlike the other options you are at the mercy of the model to get it right. Non-deterministic skills run the risk of it doing the right thing 95% of the time, then misbehaving in that one time out of twenty.

Warnings aside, this is ultimately _your workflow, your rules_. Checks still guard the workflow either way: deterministic checks run commands, while agent-judged checks ask for a clear pass/fail verdict before the workflow moves on. Main-session agent-judged checks are self-graded by the same main agent that performed or narrated the step, so they are not an independent review and cannot structurally prevent a rubber-stamp `pass: true`.

The grading transports are distinct. **Main-session grading** is in-process: the main `anvil_verdict` tool publishes to Anvil's `VerdictBus`. **Independent-review grading** uses an isolated reviewer child that writes a verdict sidecar, which the parent parses after the child exits. Its literal contract is `{ check_id, pass, reason }`. The parent accepts exactly `{ check_id, pass, reason }` and rejects payloads with extra fields or invalid fields. Parent validation requires one bounded UTF-8 JSON record; missing, malformed, duplicate, or wrong-`check_id` sidecars are transport errors, as are symlinked, oversized, extra-field, invalid-type, and unsafe-reason payloads. Reviewer prose is replaced by a fixed parent-controlled pass/fail reason before it reaches workflow state or diagnostics.

For criteria that require independence, set `review: { subagent: "auto" }` (or force `"cmux"` / `"herdr"`) on an agent check. This independent review does not fall back to the main session unless explicitly configured. Anvil starts a fresh review-only session with bounded, sanitized criteria, bounded workflow/step/check identity fields (unsafe or over-256-byte identities become deterministic SHA-256 aliases across prompts and launcher requests/names, while review path components over 255 bytes are aliased; generated task/session basenames, sidecars, and same-directory atomic temporary basenames are capped at 255 bytes), workspace guidance, structured verdict contract, and a bounded **observable step result**. The result is only the current attempt's explicit `anvil_output` text (main/chat execution) or successful delegated subagent final summary. Missing or empty output is stated explicitly. It does not include the executor transcript, hidden reasoning, raw terminal/provider output, retry feedback, or prior-step output; `{outputs.<step-id>}` is intentionally unavailable while rendering independent-review criteria.

Observable results are sanitized for unsupported control characters, conservatively redact common secret shapes (including Slack, GitLab, GitHub, OpenAI, AWS, NPM tokens, credential-bearing database URLs, JWT, cookie, Basic/Bearer authorization, and private-key forms), including quoted `.env` and JSON credential-bearing database URLs, and are limited to **8 KiB including the marker**, measured in UTF-8 bytes. Capture preprocessing inspects at most the final 64 Ki UTF-16 code units so very large reported values cannot cause unbounded sanitization work; when that scan boundary clips a line, Anvil discards the partial line (or reports missing output if no complete line remains) so a split credential label cannot bypass redaction. Ambiguous clipped or unmatched private-key markers fail closed as missing output. Oversized results use deterministic UTF-8-safe tail truncation with a visible marker. Redaction is defense in depth, not a complete secret detector, so steps should report only intentionally disclosed result text. This context is prompt-only: Anvil does not copy it into checkpoints, summaries, evidence, retry feedback, sidecars, UI diagnostics, or launcher errors. `reviewFallback` controls an unavailable backend: it defaults to `"fail"`, while explicit `reviewFallback: "main"` permits self-grading as a degraded fallback. The check's `timeoutMs` covers the full review launch and execution; it defaults to 1,800,000ms (30 minutes) for independent reviews, rather than the 300,000ms main-session verdict default.

```ts
{
	type: "agent",
	id: "quality",
	prompt: "Pass only if the implemented artifacts satisfy the acceptance criteria.",
	review: { subagent: "auto" },
	reviewFallback: "fail", // optional; this is the default
}
```

Independent reviewers launch without approval and expose only bounded, read-only workspace inspection through Anvil's `read`, `grep`, `find`, and `ls` implementations plus the verdict tool; they do not receive shell, mutation, or unrestricted built-in filesystem tools. Reviewer reads are confined to the realpath-resolved workflow cwd, skip traversal symlinks, deny symlink escapes, and block secret-like paths such as `.env` / `.envrc`, credential/key files, and `.ssh` / `.aws` / `.git` directories. User/project extensions and ambient shell startup hooks are disabled. Each review runs with an isolated home and Pi agent directory containing only the selected model provider's auth/model configuration; provider and cloud credentials for unrelated models are neither inherited nor copied, while the remaining runtime environment is narrowly allowlisted for Pi. These controls constrain reviewer-invoked filesystem access; they are not a general-purpose OS sandbox for the Pi process. When a required review backend is unavailable, Anvil records a failed gate result and applies the check's normal `onFail` policy; launch failures other than backend unavailability, timeouts, and verdict-transport failures stop the workflow as infrastructure errors rather than invoking `onFail`. Review tool output and transport diagnostics are bounded, and diagnostics never copy raw child/provider output. Recursive `find`/`grep` operations fail explicitly if secure traversal cannot complete within its directory-entry/subprocess limits rather than returning silent partial results. Because reviewer-written reasons can quote arbitrary artifact or provider secrets, Anvil replaces that prose with a fixed pass/fail reason before sidecar persistence or use in checkpoints, UI, retry feedback, reports, and resume prompts.

When a failing check uses `onFail: "continue"`, Anvil continues to the next workflow step immediately and skips any remaining checks on the current step. A valid independent-review verdict with `pass: false` is such a product-level check failure and follows `onFail`. By contrast, normal delegated-step launch, timeout, transport, and non-zero execution failures are hard workflow infrastructure errors: they bypass check retries and `forEach.onItemExhausted`, including `"continue"`, and stop before later items launch. Their persisted diagnostics are fixed parent-controlled messages rather than child/provider output.

### Step outputs

Each step has an optional captured textual output that later steps can read as `ctx.outputs["step-id"]` in function templates or `{outputs.step-id}` in string prompt/check templates. Missing outputs render as an empty string. Outputs are in-memory for the current run; if you `/anvil resume` from a later step, skipped earlier steps have no outputs. If a retry loop reruns a step, the latest successful attempt overwrites that step's output.

Declarative subagent steps capture the subagent's final summary automatically. Main-session steps only capture an output when the agent explicitly calls the `anvil_output` tool for the current step. For deterministic capture, set `outputFrom: "check-id"` on a step; when that check passes, its command output becomes the step output. Captured outputs are truncated to the last 8 KiB before being exposed to later prompts/commands.

### Retry-based model selection

When you ask Pi to build a workflow, you can tell it to use different models or thinking levels after a step has to retry. For example, `retryModelSelections: [{ retry: 0, model: "cheap/model:minimal" }, { retry: 1, model: "strong/model", thinkingLevel: "high" }]` starts cheaper on the first attempt (`retry: 0`), then upgrades after the first retry. The highest selection with `retry` less than or equal to the current retry count wins, and model selection also applies to declarative subagent launches.

This is useful when most runs should stay fast and inexpensive, but difficult cases deserve more reasoning instead of repeating the same attempt with the same settings. By default, Anvil keeps the same model and thinking level for every attempt, so nothing changes unless you ask for retry-based escalation.

You do not need to know the workflow syntax for this feature. Describe the escalation you want in plain language, and the `anvil-workflow-builder` skill will capture it while building the workflow.

### Per-item fan-out (`forEach`)

A step can declare a list of items and have Anvil run the step's prompt once per item instead of once for the whole step. Add `forEach` to a step, and the engine loops over the items deterministically — decomposition lives in `src/engine.ts`, not in the model. This is the key unlock for small local models: each item becomes one small, self-contained task ("write test stubs for `{item}`") rather than one monolithic task ("write test stubs for the feature").

Items come from one of two sources:

- A function: `items: (ctx) => JSON.parse(ctx.outputs["plan"]).files` — pairs naturally with step outputs. It must return an array of strings.
- A command: `items: { command: "git diff --name-only master", parse: "lines" }` — the command is rendered with the same shell-safe templating as deterministic checks and run like a check. `parse` defaults to `"lines"` (non-empty, trimmed); `"json"` expects a JSON array of strings.

The recommended pattern for local models is to gate a plan step with a deterministic check that its emitted file list parses, then let `forEach` enumerate that list mechanically — no model judgment in the decomposition path. See `examples/workflows/fan-out.ts`.

Inside a `forEach` step the prompt and checks can use `{item}`, `{itemIndex}` (zero-based), and `{itemCount}`; outside a `forEach` step those placeholders expand to an empty string. Each item runs with its own retry budget and its own `onFail` feedback, so one file failing and retrying never leaks feedback into another file's prompt, and `retryModelSelections` escalation applies per item. A check's `onFail: { goto }` inside a `forEach` step must target the step itself ("retry this item"); jumping to another step from within a fan-out is rejected at validation.

Subagent delegation is the intended mode — each item gets a fresh session so context never accumulates across items. Main-session and skill delegation still work but run items as sequential instructions in the main session, which defeats the context isolation that makes fan-out worthwhile for local models.

Other knobs: `maxItems` caps enumeration (default 100; exceeding it fails the step), an empty list passes the step trivially, and `onItemExhausted` decides what happens when an item exhausts its retries — `"stop"` (default) fails the step naming the item, while `"continue"` records the failure and moves on, failing the step only if every item failed. The step's captured output is a per-item digest of each item's outcome. Concurrency is sequential today; `concurrency > 1` is accepted but currently degrades to sequential with a warning.

## Develop

If you use nix, a nix dev environment is included with everything you need for development.

```bash
cd anvil
npm install
npm run typecheck
npm test
npm run dev       # pi -e ./src/index.ts
```
