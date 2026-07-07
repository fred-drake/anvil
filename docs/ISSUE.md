# anvil Code Review Issues

Full-codebase review performed 2026-07-06; re-reviewed 2026-07-07. Baseline: `npm run check` passes (typecheck clean, 187/187 tests green), so everything below is a latent defect, hardening gap, or maintainability concern — not a broken build.

All previously recorded High (H1) and Medium (M1–M4) issues were fixed and verified on 2026-07-07, and have been removed from this list.

## 🟢 Low Priority

- [ ] **L1 [DESIGN]** Agent checks are self-graded. The same main agent that performed (or narrated) a step is the one instructed to call `anvil_verdict` on it (`src/prompts.ts:169-188`), so nothing structurally prevents a rubber-stamp `pass: true`; `check.agent` is only a prose hint. Worth documenting the limitation in the README, and longer-term consider running agent checks in a fresh subagent session the way `delegation: { subagent: "cmux" }` steps run.

- [ ] **L2 [BUG]** Cross-session module-global state. `verdictBus` and `turnWaiters` (`src/index.ts:60-61`) and `subagentPane` (`src/subagent/cmux.ts:23`) are module-level singletons. If one process ever hosts multiple sessions, `session_shutdown` clears another session's pending verdicts, and `agent_start`/`agent_end` events resolve the wrong session's waiters. Move this state into the per-extension closure created in `piAnvil(pi)`.

- [x] **L3 [BUG]** ~~Pane reuse check uses substring matching.~~ Fixed: `createSurface` now matches the pane on word boundaries via `new RegExp(`(^|\\s)${escapeRegExp(subagentPane)}($|\\s)`)` (`src/subagent/cmux.ts:167`).

- [ ] **L4 [CLEANUP]** Agent-check timeout is dead-configurable. `executeAgentCheck` accepts `timeoutMs` but the engine never passes it (`src/gates.ts:118-131`, `src/engine.ts:450-458`), and `AgentCheck` has no `timeoutMs` field — so 300s is effectively hardcoded while `DeterministicCheck.timeoutMs` exists. Either add `timeoutMs` to `AgentCheck` and thread it through, or drop the parameter.

- [x] **L5 [BUG]** ~~Timed-out deterministic checks aren't reported as timeouts.~~ Fixed: `executeDeterministicCheck` now inspects `result.killed` and reports `command timed out after Xms` with the output tail (`src/gates.ts:110-113`).

- [ ] **L6 [VALIDATION]** Duplicate check ids aren't validated, and loop budgets can collide. Loop keys are `<check.id ?? stepId:checkN>-><goto>` (`src/engine.ts:396`); two checks in different steps sharing an `id` and `goto` target silently share one loop budget. Add a duplicate-check-id validation alongside the duplicate-step-id check in `src/validate.ts`.

- [ ] **L7 [UX]** Workflow name collisions are silently last-wins. `discoverWorkflows` dedupes with `byName.set` (`src/discovery.ts:45-48`); project-over-user shadowing is documented, but two same-named files *within* one directory silently drop the alphabetically-earlier one. Surface a warning/`errors` entry on the shadowed entry so `/anvil list` shows the conflict.

- [ ] **L8 [DOCS]** `onFail: "continue"` skips the step's remaining checks. When a check fails with `continue`, the engine advances to the next step immediately (`src/engine.ts:346-352`), so later checks on that step never run. Reasonable behavior, but undocumented — note it in the README/skill docs.

- [ ] **L9 [CLEANUP]** `newRunId` is duplicated verbatim in `src/index.ts:517-519` and `src/engine.ts:508-510`. Export it from one place.

- [ ] **L10 [ROBUSTNESS]** Terminal sentinel can false-match agent output. `pollForExit` falls back to scanning the last 5 screen lines for `__ANVIL_SUBAGENT_DONE_<n>__` (`src/subagent/cmux.ts:18-19`, `:251-253`); a subagent that prints that string (e.g. while inspecting anvil itself) is treated as exited. Rare, but a per-launch random nonce in the sentinel would eliminate it.

- [ ] **L11 [BUG]** Slash-command completions resolve workflows against the wrong directory. `getArgumentCompletions` uses `process.cwd()` (`src/index.ts:122`) while the autocomplete provider, `handleList`, `handleValidate`, and `handleRun` all use `ctx.cwd` (`src/index.ts:101,179,333,347`). When the session cwd differs from the process cwd, completions offer workflows that `/anvil run` then can't find, or hide ones it could. If the completions API can't supply a context, prefer dropping that path in favor of the ctx-aware autocomplete provider.

- [x] **L12 [VALIDATION]** ~~`defaults.onFail` goto targets aren't checked against step ids.~~ Fixed: defaults validation now receives the collected step ids and rejects dangling `defaults.onFail.goto` targets.

- [ ] **L13 [UX]** Goto retries accumulate check history. `stepState.checks` is appended on every attempt and never reset when a goto loops the step (`src/engine.ts:316`, `:354`), so the widget's `[n/m checks]` counter and the summary table mix stale failed attempts with the final passing run (e.g. `[2/4 checks]` for a fully passing 2-check step after one retry). Reset per attempt, or render only the latest attempt per check.

- [ ] **L14 [CLEANUP]** Stale verdict waiters linger after "no verdict reported". When `executeAgentCheck` gives up (`src/gates.ts:165-171`), the `VerdictBus` waiter stays registered for the rest of its 300s window, and a late `anvil_verdict` call is answered with "Anvil verdict recorded" (`src/index.ts:74-81`) even though the result is discarded. Cancel the waiter on the failure return, so a late verdict gets the "no active check" reply.

- [x] **L15 [DOCS]** ~~Unclosed inline code span in README.~~ Fixed: the cmux launch note now closes the `cmux pi` inline code span in `README.md`.

- [ ] **L16 [DOCS/SECURITY]** Workflow discovery executes workflow modules. `/anvil` completions, `list`, and `validate` import every `.pi/anvil/workflows/*.ts` via jiti (`src/discovery.ts:55-64`), running its top-level code. This matches pi's package.json-extension trust model, but it's worth a README note that opening a session in an untrusted repo and touching `/anvil` executes project-controlled code.

- [ ] **L17 [ROBUSTNESS]** Herdr subagent workspace reuse has no liveness fallback. After the first split, `subagentWorkspace` is reused blindly for later tabs (`src/subagent/herdr.ts:19-20`, `:79`, `:101-103`), unlike cmux's pane-exists check; if the workspace is closed/moved or inferred as `""` because the environment lacks `HERDR_WORKSPACE_ID`, later delegated steps can fail or open in the currently focused workspace. Consider deriving the workspace from Herdr's JSON response and validating it before reusing it.
