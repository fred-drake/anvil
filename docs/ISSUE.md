# anvil Code Review Issues

## Observable-result heuristic does not redact arbitrary token labels

**Finding:** The observable-result sanitizer redacts supported credential shapes and common key labels, but an arbitrary label such as `DEPLOY_TOKEN=<opaque value>` does not necessarily match its heuristic rules.

**Impact:** A workflow step that explicitly reports a custom-named credential could expose it to an independent review prompt. The prompt remains isolated, bounded, and non-persistent, but heuristic redaction is not a complete secret detector.

**Follow-up:** Consider a broader assignment-label policy without over-redacting ordinary observable output. Until then, workflow steps must report only intentionally disclosed result text and must not emit secrets.
