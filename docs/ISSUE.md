# anvil Code Review Issues

## 🟢 Low Priority

- [ ] **L21 [ROBUSTNESS]** Closed surface with a slow-failing `readScreen` is reported as a timeout. In `pollForExitWithReadScreen` (`src/subagent/exit.ts:75-85`), the `catch` block checks `Date.now() >= deadline` before classifying the read failure, so if `readScreen` fails slowly enough that the deadline passes before `consecutiveReadFailures` reaches `DEFAULT_READ_SCREEN_FAILURE_LIMIT`, a genuinely-closed surface throws `Subagent timed out after <ms>` instead of `Subagent surface closed before completion`. Harmless at the default 1,800,000 ms timeout, but the diagnostic is misleading. Reorder so a completed read-failure streak is classified before the deadline check (or fold the late-sidecar/close-detection ahead of the timeout throw).
