<p align="center">
  <img src="assets/anvil-logo.png" alt="Anvil logo" width="320">
</p>

# Anvil

A Pi extension that runs declarative TypeScript workflows with deterministic and agent-judged gates.

Anvil is for those Pi tasks where you keep thinking, “I want the agent to do this the same way every time, but I also want it to use judgment when a script cannot tell the whole story.” You can chain steps together, gate each step with hard pass/fail checks or agent-reviewed thumbs-up/thumbs-down checks, and keep the process moving without babysitting every turn.

## Features at a glance

- Build the workflow in your own words and Anvil will worry about how to properly build it.
- For each workflow step, set any number of gating checks that must pass. Checks can be deterministic, like a script or executable that returns exit code `0`, or non-deterministic, where the active harness evaluates the result and gives a 👍 or 👎 based on what it thinks should happen.
- Request subagents in ordinary prompt text when useful; the active harness's skills and plugins decide whether and how to delegate.
- Optionally define the number of times a step has to be retried before bailing.
- Optionally define a different model and thinking level for each step, including retry-based upgrades.
- Pass captured text from earlier steps into later prompts and checks with `{outputs.<step-id>}`.
- Fan a step out over a list of items with `forEach`, running one harness turn per item so small local models get one bite-sized task at a time.

## Build workflows by talking to Pi

The intended way to create a workflow is to describe what you want in plain language and let the agent shape it into something Anvil can run. This extension includes an `anvil-workflow-builder` skill that guides that conversation, asks for missing details when it needs them, and handles the workflow structure for you.

Although it follows a typescript schema under the hood, the intention is to say what the workflow should do in your own words. If Anvil needs exact commands, gating behavior, model choices, or whether a prompt should request subagents, it will ask.

Workflows live in:

- User: `~/.pi/agent/anvil/workflows/*.ts` (also `.js`/`.mjs`)
- Project: `.pi/anvil/workflows/*.ts` (project workflows win on name collisions)

⚠️ Workflow discovery for `/anvil list`, `/anvil validate`, `/anvil run`, and completions imports workflow modules, so their top-level code executes. Only use Anvil in trusted projects; opening an untrusted repo and touching `/anvil` can run project-controlled code.

## Commands

```text
/anvil list
/anvil validate <name>
/anvil run <name> <free-form task input>
/anvil run --watch <name> <free-form task input>
/anvil history [name]
/anvil report [run-id-prefix]
/anvil status
/anvil resume <step> [retry-number]
/anvil abort
```

Use `/anvil list` to see available workflows, `/anvil validate` to check that one is ready, and `/anvil run` to start a workflow with whatever task input you want to give it.

`/anvil run --watch <name> <input>` is an opt-in, nondeterministic development mode for trusted workflows. Before each next outer workflow step, Anvil checks a filesystem signature for the canonical-path-pinned source and local workflow-root TypeScript/JavaScript inputs. When that signature changes, it fresh-imports only the originally selected, canonical-path-pinned workflow module and validates the complete candidate (including every `onFail.goto` target); unchanged boundaries do not re-import it. It never reloads during a step or between `forEach` items. A load, parse, validation, or source-identity failure emits a bounded, redacted warning and retains the last valid definition and execution state. A valid changed definition reconciles state by stable step id: completed/skipped surviving steps and their outputs remain, removed outputs are discarded, newly inserted pending steps run in current-definition order, and an explicit pending `goto` remains targeted by id. Status, widgets, model selection, goto routing, and the final summary use the active definition. Checkpoints carry only a bounded monotonic definition revision; this history provenance never includes definition content and never drives execution.

Watch mode repeatedly executes trusted TypeScript module top-level code and allows edits to change future commands and prompts, so it amplifies the existing trusted-project boundary. It is disabled for ordinary runs and resume and does not discover or execute sibling workflow modules. Use it only for local workflow development, never as a deterministic unattended-run guarantee.

Use `/anvil status` as a read-only query for the active run's ID, workflow, current progress, retry count, and elapsed time. It reports when no Anvil workflow is running. Run identity and start time come from in-memory active state, while the engine publishes current progress directly from its authoritative active workflow definition, including accepted watch-mode reloads.

Use `/anvil history [name]` to list recent runs in the current Pi session, optionally for one workflow. History shows each run's state, duration, last or failing step, and check summary. Use `/anvil report [run-id-prefix]` for the latest run or a detailed report for one run, including reconstructed per-step status, retries, timing, deterministic and agent-check verdicts, Git workspace evidence, and changed files. The final workflow summary links to the same report.

History and reports are session-scoped and presentation-only: they read bounded recent windows of Anvil's append-only checkpoint entries and never open recorded paths. Persisted display fields are treated as untrusted, size-capped, Markdown-neutralized, and redacted for supported credential and sensitive-path patterns. A truncation notice appears when older entries or report details are omitted.

Anvil captures a Git snapshot before the run, after every successful deterministic check, and after each agent approval. If an agent approval reports pass after the workspace changed since the most recent successful deterministic verification, Anvil fails that approval as stale. This prevents a review from approving code that is different from what was verified; workflows should rerun deterministic verification after intentional changes.

Use `/anvil resume` after a failed or aborted run to see a numbered step map, for example `1. Plan`, `2. Implement`, `3. Verify`. The map includes the prior run timestamp and failure reason. Its suggested resume point follows the historical last-started **step id** into the current workflow definition, so insertion, removal of unrelated steps, and reordering do not silently change the target. If that id was renamed or removed, Anvil reports the mismatch and shows the current map without launching. Then run `/anvil resume <step> [retry-number]` with a one-based current-definition step number; this explicit number is an intentional positional override. Omit `retry-number` when no retry count is seeded (so `{loop}` starts at 0 for the resumed step); normal workflow retry policies still apply.

Resume skips completed surviving steps before the selected target and restores their bounded output snapshots by id. Newly inserted or otherwise pending pre-target steps execute first in current-definition order; the selected retry seed remains attached to the target. The target and all later/re-executed outputs are cleared. These execution snapshots are deliberately excluded from history, reports, maps, summaries, and diagnostics. Session checkpoints are locally editable and are trusted at the same level as workflow input: structural validation and an 8 KiB UTF-8 limit constrain recovery, but do not authenticate persisted text or make it safe from prompt injection if an attacker can modify the session. Command templates still apply Anvil's existing shell-safe interpolation.

## Harness-managed subagents

Anvil does not select or launch subagents. To use them, say so in the step or agent-check prompt, for example: `Use subagents to implement this change.` The active harness's installed skills and plugins decide how delegation works.

Anvil cannot verify that delegation occurred or enforce child isolation, model choice, timeout, cancellation, or verdict provenance. Keep deterministic or agent gates when correctness matters. Agent checks must still submit the exact `anvil_verdict`; steps that expose text to later steps must still call `anvil_output` or use `outputFrom`.

Agent-judged checks run in the active harness turn and are self-graded by the same main agent unless the prompt asks the harness to use a fresh review subagent. For example: `Use a fresh review subagent to independently verify the implementation, then submit the exact anvil_verdict for this check.` This prompt expresses intent but cannot prevent a rubber-stamp `pass: true` or prove independence.

When a failing check uses `onFail: "continue"`, Anvil continues to the next workflow step immediately and skips any remaining checks on the current step. Harness-turn failures stop the workflow with the available bounded diagnostic; Anvil does not promise child launch or transport diagnostics.

### Step outputs

Each step has an optional captured textual output that later steps can read as `ctx.outputs["step-id"]` in function templates or `{outputs.step-id}` in string prompt/check templates. Missing outputs render as an empty string. Outputs are kept in memory and bounded snapshots are checkpointed for safe resume; completed surviving steps before the resume target are skipped and restored by id, while newly pending pre-target steps execute first. If a retry loop reruns a step, the latest successful attempt overwrites that step's output.

A step captures harness-reported text only when the harness explicitly calls the `anvil_output` tool for the current step, including when the prompt requested child work. For deterministic capture, set `outputFrom: "check-id"` on a step; when that check passes, its command output becomes the step output. Captured outputs are truncated to the last 8 KiB before being exposed to later prompts/commands.

### Retry-based model selection

When you ask Pi to build a workflow, you can tell it to use different models or thinking levels after a step has to retry. For example, `retryModelSelections: [{ retry: 0, model: "cheap/model:minimal" }, { retry: 1, model: "strong/model", thinkingLevel: "high" }]` starts cheaper on the first attempt (`retry: 0`), then upgrades after the first retry. The highest selection with `retry` less than or equal to the current retry count wins. This selects the model for the main harness turn; it does not automatically select models for any children the harness may launch.

This is useful when most runs should stay fast and inexpensive, but difficult cases deserve more reasoning instead of repeating the same attempt with the same settings. By default, Anvil keeps the same model and thinking level for every attempt, so nothing changes unless you ask for retry-based escalation.

You do not need to know the workflow syntax for this feature. Describe the escalation you want in plain language, and the `anvil-workflow-builder` skill will capture it while building the workflow.

### Per-item fan-out (`forEach`)

A step can declare a list of items and have Anvil run the step's prompt once per item instead of once for the whole step. Add `forEach` to a step, and the engine loops over the items deterministically — decomposition lives in `src/engine.ts`, not in the model. This is the key unlock for small local models: each item becomes one small, self-contained task ("write test stubs for `{item}`") rather than one monolithic task ("write test stubs for the feature").

Items come from one of two sources:

- A function: `items: (ctx) => JSON.parse(ctx.outputs["plan"]).files` — pairs naturally with step outputs. It must return an array of strings.
- A command: `items: { command: "git diff --name-only master", parse: "lines" }` — the command is rendered with the same shell-safe templating as deterministic checks and run like a check. `parse` defaults to `"lines"` (non-empty, trimmed); `"json"` expects a JSON array of strings.

The recommended pattern for local models is to gate a plan step with a deterministic check that its emitted file list parses, then let `forEach` enumerate that list mechanically — no model judgment in the decomposition path. See `examples/workflows/fan-out.ts`.

Inside a `forEach` step the prompt and checks can use `{item}`, `{itemIndex}` (zero-based), and `{itemCount}`; outside a `forEach` step those placeholders expand to an empty string. Each item runs with its own retry budget and its own `onFail` feedback, so one file failing and retrying never leaks feedback into another file's prompt, and `retryModelSelections` escalation applies per item. A check's `onFail: { goto }` inside a `forEach` step must target the step itself ("retry this item"); jumping to another step from within a fan-out is rejected at validation.

Each item gets one harness turn. If isolation is useful, put a request such as `Use subagents to handle {item}` in the prompt; the harness may honor that request through its installed skills and plugins, but Anvil does not guarantee a fresh child session.

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
