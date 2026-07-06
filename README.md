# pi-anvil

A starter TypeScript extension for the pi coding agent.

## Prerequisites

- Nix with flakes enabled
- direnv (recommended) with the shell hook installed

## Develop

```bash
cd pi-anvil
direnv allow      # automatically enters the Nix dev shell
npm install       # installs pi packages and TypeScript
npm run typecheck
npm run dev       # equivalent to: pi -e ./src/index.ts
```

The Nix shell provides Node.js, npm, git, and direnv. It also adds `node_modules/.bin` to `PATH` so the local `pi` and `tsc` binaries are available after `npm install`.

## Extension entrypoints

- Main source: [`src/index.ts`](src/index.ts)
- Package metadata entrypoint: `package.json` → `pi.extensions`
- Project-local auto-discovery wrapper: [`.pi/extensions/pi-anvil.ts`](.pi/extensions/pi-anvil.ts)

When running `pi` from this repository, pi can discover the wrapper under `.pi/extensions/`. After editing the extension, use `/reload` in pi.

## What is included

- `anvil_echo` custom tool
- `/anvil` custom command
- `session_start` notification hook
- `flake.nix`, `shell.nix`, and `.envrc` for Nix + direnv development
