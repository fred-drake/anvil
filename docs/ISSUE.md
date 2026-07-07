# pi-anvil Code Review Issues

Full-codebase review performed 2026-07-06. Baseline: `npm run check` passes (typecheck clean, 72/72 tests green), so everything below is a latent defect, hardening gap, or maintainability concern — not a broken build.

## 🟢 Low Priority

- [ ] **L1 [DESIGN]** Agent checks are self-graded. The same main agent that performed (or narrated) a step is the one instructed to call `anvil_verdict` on it (`src/prompts.ts:89-108`), so nothing structurally prevents a rubber-stamp `pass: true`; `check.agent` is only a prose hint. Worth documenting the limitation in the README, and longer-term consider running agent checks in a fresh subagent session the way `delegation: { subagent: "cmux" }` steps run.

- [ ] **L2 [BUG]** Cross-session module-global state. `verdictBus` and `turnWaiters` (`src/index.ts:59-60`) and `subagentPane` (`src/subagent/cmux.ts:21`) are module-level singletons. If one process ever hosts multiple sessions, `session_shutdown` clears another session's pending verdicts, and `agent_start`/`agent_end` events resolve the wrong session's waiters. Move this state into the per-extension closure created in `piAnvil(pi)`.

- [ ] **L3 [BUG]** Pane reuse check uses substring matching. `tree.includes(subagentPane)` (`src/subagent/cmux.ts:163-164`) lets `pane:1` match `pane:12`, so a closed pane can be treated as alive and tab creation fails or lands in the wrong pane. Match on a boundary (e.g. regex `\bpane:1\b` or parse the tree output).

- [ ] **L4 [CLEANUP]** Agent-check timeout is dead-configurable. `executeAgentCheck` accepts `timeoutMs` but the engine never passes it (`src/gates.ts:120-124`, `src/engine.ts:435-443`), and `AgentCheck` has no `timeoutMs` field — so 300s is effectively hardcoded while `DeterministicCheck.timeoutMs` exists. Either add `timeoutMs` to `AgentCheck` and thread it through, or drop the parameter.

- [ ] **L5 [BUG]** Timed-out deterministic checks aren't reported as timeouts. `EngineExecResult.killed` is never inspected (`src/gates.ts:100-108`), so a check killed at `timeoutMs` yields a confusing "command exited N" / tail-of-output reason. Include "timed out after Xms" in the reason when `killed` is set.

- [ ] **L6 [VALIDATION]** Duplicate check ids aren't validated, and loop budgets can collide. Loop keys are `<check.id ?? stepId:checkN>-><goto>` (`src/engine.ts:381`); two checks in different steps sharing an `id` and `goto` target silently share one loop budget. Add a duplicate-check-id validation alongside the duplicate-step-id check in `src/validate.ts`.

- [ ] **L7 [UX]** Workflow name collisions are silently last-wins. `discoverWorkflows` dedupes with `byName.set` (`src/discovery.ts:28-33`); project-over-user shadowing is documented, but two same-named files *within* one directory silently drop the alphabetically-earlier one. Surface a warning/`errors` entry on the shadowed entry so `/anvil list` shows the conflict.

- [ ] **L8 [DOCS]** `onFail: "continue"` skips the step's remaining checks. When a check fails with `continue`, the engine advances to the next step immediately (`src/engine.ts:331-337`), so later checks on that step never run. Reasonable behavior, but undocumented — note it in the README/skill docs.

- [ ] **L9 [CLEANUP]** `newRunId` is duplicated verbatim in `src/index.ts:504-506` and `src/engine.ts:493-495`. Export it from one place.

- [ ] **L10 [ROBUSTNESS]** Terminal sentinel can false-match agent output. `pollForExit` falls back to scanning the last 5 screen lines for `__ANVIL_SUBAGENT_DONE_<n>__` (`src/subagent/cmux.ts:18`, `:246`); a subagent that prints that string (e.g. while inspecting pi-anvil itself) is treated as exited. Rare, but a per-launch random nonce in the sentinel would eliminate it.
