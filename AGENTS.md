# AGENTS.md

## Project Overview

Skyloom is a TypeScript/CommonJS local-first multi-agent CLI, TUI, Web UI, and gateway runtime. Core source lives in `src/`, tests live in `tests/`, bundled config lives in `config/`, and build output goes to `dist/`.

## Commands

- Install local dependencies: `CI=1 npm ci` (PowerShell: `$env:CI='1'; npm ci`) to skip the postinstall global link.
- Type check: `npm run type-check`
- Test: `npm test -- --run`
- Lint: `npm run lint`
- Build: `npm run build`
- Run CLI from build: `node dist/cli/main.js`

## Development Rules

- Prefer small, reversible changes that match existing TypeScript patterns.
- Add or update Vitest coverage for behavior changes, especially CLI parsing, config merging, security guards, Web API behavior, and tool execution.
- Keep bundled runtime behavior local-first and conservative: do not expose unauthenticated APIs to the network unless the operator explicitly opts in.
- Do not commit generated `dist/`, `node_modules/`, local config, or credentials.
- Treat `~/.skyloom/config.yaml` and API keys as sensitive. Tests should use temporary directories or mocks instead of touching real user config.
- When changing command execution, networking, filesystem writes, or gateway adapters, verify both the success path and the refusal/error path.

## Architecture Notes

- `src/cli/main.ts` is the main command entry.
- `src/core/factory.ts` wires agents, tools, memory, plugins, MCP, and workspace setup.
- `src/core/config.ts` owns bundled/user config loading and merging.
- `src/core/security.ts`, `src/core/sandbox.ts`, and `src/tools/guards.ts` are the primary safety boundary.
- `src/web/server.ts` is an unauthenticated local API surface; keep loopback, Host, Origin, request-size, and parsing checks tight.
- `src/gateway/` contains external channel adapters and should fail closed on malformed platform payloads.

## Verification Before Completion

Run the narrowest relevant test first, then at least:

```bash
npm run type-check
npm test -- --run
npm run build
```

If a check cannot run, document the reason and the next-best validation.

## Delivery Workflow

For each completed optimization batch:

1. Run targeted tests, then type-check, lint, the full test suite, build, and package smoke tests.
2. Commit and push the current pull-request branch to GitHub.
3. Wait for every required GitHub Actions check to pass; diagnose and fix failures before reporting completion.
4. Rebuild locally, run `npm link`, verify `sky version`, then restart and health-check the local Web service on `127.0.0.1:7777`.
