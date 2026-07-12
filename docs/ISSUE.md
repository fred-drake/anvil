# anvil Code Review Issues

## Observable-result heuristic does not redact arbitrary token labels

**Finding:** The observable-result sanitizer redacts supported credential shapes and common key labels, but an arbitrary label such as `DEPLOY_TOKEN=<opaque value>` does not necessarily match its heuristic rules.

**Impact:** A workflow step that explicitly reports a custom-named credential could expose it to an independent review prompt. The prompt remains isolated, bounded, and non-persistent, but heuristic redaction is not a complete secret detector.

**Follow-up:** Consider a broader assignment-label policy without over-redacting ordinary observable output. Until then, workflow steps must report only intentionally disclosed result text and must not emit secrets.

## Phase 4 checklist omits truncation regression

**Finding:** `docs/independent-review-breakdown.md` lists Phase 4 prompt-context tests but omits the required truncation and size-limit regression, despite coverage in `test/observable-result.test.ts`.

**Impact:** The implementation is covered, but the phase contract does not fully communicate the required bounded-output behavior.

**Follow-up:** Add the truncation/size-limit regression to the Phase 4 test checklist.
