# Feature 6 — Named input parameters

Back to [Feature backlog](../FEATURE.md#6-named-input-parameters).

## Summary

Let a workflow declare named parameters and reference them as `{params.<name>}` (or
`{<name>}`) in templates, instead of parsing structured values out of the single
free-form `{input}` string. Validate provided params at `validate` time and run start,
and feed param names into completions.

## Motivation

`/anvil run <name> ...` passes one free-form string, and templating is limited to
`{input}` and `{loop}`. Workflows that need structured inputs must regex them out of the
free text — exactly what `examples/workflows/demo.ts:29` does to recover a filename. A
declared param schema makes templating reliable, gives clear "missing required param"
errors, and improves completion.

## Current state (grounding)

- `WorkflowDefinition` (`src/types.ts:105`) has `name`, `description`, `defaults`,
  `steps`. `WorkflowContext` (`src/types.ts:1`) carries only `input`.
- Run args are parsed by `parseRunArgs` (`src/index.ts:576`) into `{ name, input }`;
  `input` is the entire remainder. It flows to `runWorkflow({ input, ... })`
  (`src/index.ts:199`).
- Templating understands `{input}`/`{loop}` only: `replaceTemplatePlaceholders`
  (`src/prompts.ts:42`) and `renderCommandTemplateString` (`src/prompts.ts:35`).
- Validation is key-set driven: `WORKFLOW_KEYS` (`src/validate.ts:18`) and per-section
  validators; adding a top-level `params` key requires touching `WORKFLOW_KEYS` and adding
  a `validateParams`.

## Design

### Schema (`src/types.ts`)

```ts
export interface WorkflowParam {
    name: string;                 // /^[a-zA-Z_][a-zA-Z0-9_]*$/
    description?: string;
    required?: boolean;           // default false
    default?: string;             // used when not required and omitted
}

export interface WorkflowDefinition {
    name: string;
    description?: string;
    params?: WorkflowParam[];
    defaults?: { /* unchanged */ };
    steps: WorkflowStep[];
}
```

Keep `params` values as strings (workflow inputs are textual and flow into prompts and
shell). Complex typing is out of scope.

### Argument parsing (`src/index.ts`)

Extend run parsing without breaking the free-form contract:

- Keep `{input}` = the full remainder after the workflow name (unchanged), so every
  existing workflow behaves identically.
- Parse `key=value` / `--key value` tokens into a `params` record. Decide precedence:
  recommended — recognized `key=value` pairs are extracted into params, and `{input}`
  remains the full raw remainder (so a workflow can use either). Document the exact rule;
  ambiguity here is the main design risk.
- Alternative (cleaner but stricter): when a workflow declares `params`, require
  `key=value` form and treat leftover text as `{input}`. Pick one and document it.

### Context + templating

- Add `params: Record<string, string>` to `WorkflowContext` (`src/types.ts:1`), populated
  by `makeWorkflowContext` (`src/engine.ts:577`) from a run-level params record threaded
  through `RunWorkflowOptions` (`src/engine.ts:80`).
- String templates: add `{params.<name>}` (and optionally bare `{<name>}` for declared
  params) in `replaceTemplatePlaceholders` (`src/prompts.ts:42`).
- Command templates: inject each param as a safely-quoted shell variable via
  `renderCommandPlaceholders` (`src/prompts.ts:60`), same mechanism as `{input}` — never
  raw interpolation (`AGENTS.md`).
- Apply defaults for omitted non-required params when building the params record.

### Validation (`src/validate.ts`)

- Add `"params"` to `WORKFLOW_KEYS` (`src/validate.ts:18`).
- Add `validateParams(value.params, errors)`: array of objects; each has a valid `name`
  (regex), optional string `description`, optional boolean `required`, optional string
  `default`; no duplicate names; a param cannot be both `required` and have a `default`.
- Run-time check in `handleRun` (`src/index.ts:150`): before launching, ensure all
  `required` params are supplied; if not, notify with the missing names and abort the run
  (mirrors the existing early guards like the unavailable-backend check at
  `src/index.ts:183`).

### Completions

- After the workflow name is chosen in `getAnvilCompletions` (`src/index.ts:543`), when
  the selected workflow declares params, suggest `name=` tokens for its params (labels
  from `WorkflowParam.description`). This requires resolving the workflow during
  completion (already done for name completion via `discoverWorkflows`).

## Implementation steps

1. `src/types.ts`: add `WorkflowParam`, `params` on `WorkflowDefinition`, `params` on
   `WorkflowContext`.
2. `src/validate.ts`: `WORKFLOW_KEYS` + `validateParams`.
3. `src/index.ts`: parse params in run args; required-param guard; param completions.
4. `src/engine.ts`: thread params through `RunWorkflowOptions` →
   `makeWorkflowContext`.
5. `src/prompts.ts`: `{params.<name>}` in string + command templating with safe quoting.
6. Docs, skill, example; broad tests.

## Testing

- `test/validate.test.ts`: valid/invalid param schemas (bad name, duplicate, required +
  default conflict, non-string default).
- `test/anvil-command.test.ts`: run-arg parsing extracts params; missing required param
  blocks the run with a clear message; `{input}` unchanged for param-less workflows.
- Templating tests: `{params.x}` renders in string and command form with correct quoting;
  defaults applied; undeclared param reference behavior documented and asserted.
- `test/completions.test.ts`: param-name completions after a param-declaring workflow.

## Docs to update

Full synchronized set per `AGENTS.md`: `src/types.ts` comments, `README.md`
(param syntax + run examples), `skills/anvil-workflow-builder/SKILL.md` (interview for
params), and an example workflow using params (could replace the demo regex).

## Risks & open questions

- **Public-contract change** — keep additive; param-less workflows must be identical to
  today.
- **Parsing ambiguity** is the real risk: how `key=value` coexists with free-form
  `{input}`. Choose one precedence rule, document it prominently, and cover it with tests.
  Recommendation: params are extracted from `key=value` tokens while `{input}` stays the
  full raw remainder, so authors can adopt params incrementally.
- **Shell safety** — params flow into deterministic-check commands; reuse the existing
  safe-quoting placeholder machinery, never string interpolation.
- **Interaction with #3 (outputs).** `{params.*}` and `{outputs.*}` share the templating
  layer; implement them with the same placeholder mechanism so they compose cleanly.
