# Repository Guidelines

## Scope

These instructions apply to the whole repository.

## Project overview

Anvil is a Pi coding-agent extension for declarative TypeScript workflows with deterministic and agent-judged gates. Core runtime code lives in `src/`, the Pi extension entrypoint is `extensions/anvil/index.ts`, tests live in `test/`, workflow examples live in `examples/workflows/`, and project workflows live in `.pi/anvil/workflows/`.

## Setup and verification

- Use Node.js 22+ (`package.json` engines); the Nix shell provides Node 24 and local `node_modules/.bin` on `PATH`.
- Install dependencies with `npm install` when needed.
- Primary verification command: `npm run check`.
- Type-only verification: `npm run typecheck`.
- Test-only verification: `npm test`.
- Coverage verification: `npx vitest run --coverage` (thresholds are 85% statements/branches/functions/lines in `vitest.config.ts`).
- Manual extension run: `npm run dev` (`pi -e ./src/index.ts`).

## Coding conventions

- TypeScript is strict ESM using `moduleResolution: "NodeNext"`.
- Include explicit `.ts` extensions in relative imports.
- Prefer named types/interfaces near the code that uses them unless they are part of the workflow public contract in `src/types.ts`.
- Follow the existing style: tabs for indentation, double quotes, semicolons, and concise helper functions.
- Keep command execution and shell quoting centralized in existing helpers where possible; avoid ad-hoc shell interpolation for user/workflow input.
- Do not add build artifacts, coverage output, `node_modules/`, `.direnv/`, or local secret files.

## Anvil-specific guidance

- Workflow public contract changes usually require synchronized updates to:
  - `src/types.ts`
  - `src/validate.ts`
  - `src/engine.ts` and/or related runtime modules
  - tests in `test/*`
  - `README.md`
  - `skills/anvil-workflow-builder/SKILL.md`
  - `examples/workflows/demo.ts`
- Workflow files must live only in Anvil workflow directories:
  - project scope: `.pi/anvil/workflows/*.ts`
  - user scope: `~/.pi/agent/anvil/workflows/*.ts`
- Validate workflow behavior through tests; `/anvil validate <name>` is useful for manual checks when running Pi.
- Project workflows intentionally shadow user workflows by name; preserve that documented behavior unless explicitly changing discovery semantics.
- Agent-judged checks must call the `anvil_verdict` tool with the exact check id supplied by Anvil.

## Testing expectations

- Add or update Vitest coverage for behavior changes.
- Prefer focused unit tests around runtime modules (`engine`, `gates`, `validate`, `discovery`, `ui`, subagent adapters) before broader command tests.
- Keep tests deterministic: isolate environment variables, avoid relying on real cmux/herdr processes, and use fakes/mocks like existing tests.
- If a change affects CLI/slash-command behavior, update command/completion tests as well as README usage text.

## Documentation and issue tracking

- Keep user-facing README examples aligned with actual schema and command behavior.
- Keep `skills/anvil-workflow-builder/SKILL.md` aligned with workflow authoring rules; the skill is part of the user experience.
- `docs/ISSUE.md` tracks known non-blocking review findings. When a review discovers new non-blocking defects or cleanup items, append them there using the existing style.

## Working-tree safety

- Check `git status --short` before editing and avoid overwriting unrelated user changes.
- Prefer small, focused changes and atomic commits when commits are requested.
