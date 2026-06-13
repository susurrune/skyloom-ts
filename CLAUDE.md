# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Skyloom (天空织机) is a local-first multi-agent terminal framework: six weather-themed agents (Fog/Rain/Frost/Snow/Dew/Fair) collaborate over an event bus, three-layer memory, and a DAG orchestrator. README.md has the exhaustive feature/tool/skill tables; this file covers what you need to be productive editing the code.

## Commands

```bash
npm run build         # tsc → dist/ (the `sky` bin runs dist/, NOT src — rebuild before manual CLI testing)
npm run dev           # tsc --watch
npm test              # vitest (run mode is `vitest run`; bare `vitest` watches)
npm run type-check    # tsc --noEmit, strict mode
npm run lint          # eslint src --ext .ts
npm run format        # prettier

npx vitest run tests/agent.test.ts                 # single file
npx vitest run tests/agent.test.ts -t "tool call"  # single test by name substring
```

- `pretest` runs `type-check` automatically before `npm test`.
- `tsconfig.json` **excludes `tests/`**, so `npm run type-check` does not type-check test files — only Vitest (via esbuild) compiles them. A type error in a test surfaces at test run, not type-check.
- After `npm install`, `postinstall` runs `scripts/link.js`; the published `sky` bin maps to `dist/cli/main.js`.

## Architecture

### Boot path
`src/cli/main.ts` (Commander command registration + REPL) → `core/factory.ts` `createSystemContext()` builds the whole system: `loadConfig()` → `MessageBus` → `LLMClient` → `ToolRegistry` (builtin tools + skills, then per-agent delegate/model/todo tools) → six `BaseAgent` subclasses (`src/agents/*.ts`) → optional MCP client. `SystemContext.initAll()` connects MCP and calls `agent.init()` on each. Web (`sky web`) and the MCP server (`sky mcp` → `core/mcp_server.ts`) both reuse `createSystemContext`.

### The agent loop is the hot path — `src/core/agent.ts` (`BaseAgent`)
This ~1600-line class is the center of gravity. There are **two execution paths that share one tool-execution pipeline**:
- `chatStreamImpl` — streaming chat (the interactive TUI/web path), an async generator yielding `content`/`reasoning`/`tool_status`/`tool_done`/`done` events.
- `llmLoop` — batch path used by `executeTask` (orchestration/delegation), non-streaming.

Both funnel every tool round through `executeToolCalls()`. **When changing tool-execution behavior (approval, dedup, hooks, checkpoints, result clamping), edit `executeToolCalls` so both paths stay consistent** — this consolidation is deliberate. Its phases: parse args → approve dangerous tools (serial, may prompt) → in-round dedup of cacheable tools → bounded-concurrency execute (`mapBounded`, default 4) → record clamped results to memory.

Other things that live here and are easy to break:
- **Round budget**: `_maxToolRounds` (20) auto-extends toward `_maxToolRoundsHardCap` (40); `LoopGuard` (`agent/guard.ts`) stops narration/repeat/search-storm loops.
- **System prompt** is rebuilt (`rebuildSystemPrompt`) from layered pieces (persona → workspace → behavior rules → project memory (SKY.md) → identity → active-skill prompts). It is stored as a single `system` message; a live time tag is re-injected each turn.
- **Per-turn fact recall** (`messagesWithRecall`) is memoized by the turn's user query — don't reintroduce per-round recall calls.
- `cooperative cancel`: an `AbortSignal` threads through the loop and `mapBounded`; queued (not-yet-started) tools short-circuit to `[cancelled]`.

### Routing & orchestration
`core/router.ts` classifies each input in <1ms (no LLM) into `direct` / `single` / `orchestrate`. Orchestration uses Snow to decompose a goal into a DAG; `core/pipelines.ts` holds 9 prebuilt DAG templates that bypass LLM decomposition when matched. `core/tool_router.ts` (`selectRelevantTools`) narrows the ~50-tool surface to ~12 per turn by keyword scoring — **it must stay cheap (no embeddings/LLM calls)**; infra tools and active-skill `requiredTools` are always included.

### Tools — `src/core/tool.ts` + `src/tools/*`
`ToolRegistry.execute` wraps every call with: circuit breaker, LRU result cache (cacheable tools, keyed by `stableStringify` of params), param coercion/validation, timeout (30s default), and retries. Tool implementations live in `src/tools/` (`builtin.ts`, `computer.ts`, `delegate.ts`, `todo.ts`, `model_tool.ts`); skills register their own tools on activation.

### Memory — `src/core/memory.ts`
Three layers: short-term (SQLite-persisted conversation, `sql.js` WASM), working (in-memory task scope), long-term (persisted KV with TF-IDF/cosine recall via `core/vector.ts`). DB path defaults to `~/.skyloom`. Sessions auto-resume on start; `/compact` summarizes older context.

### Config — `src/core/config.ts`, `config/*.yaml`
Layered YAML merge: `config/default.yaml` ← `~/.skyloom/config.yaml`. `config/models.yaml` (loaded via `core/catalog.ts`) is the **single source of truth for context windows and cost** — add new models there, not inline. `config/providers.yaml` maps providers to base URLs/env vars.

## Conventions

- **Lazy `require()` inside methods** is intentional throughout (`require('./verify')`, `require('./file_checkpoint')`, `require('./hooks')`, etc.) — it breaks import cycles and makes optional subsystems best-effort. Keep these wrapped in try/catch so a missing/failing module never breaks the tool loop. (Under Vitest the source `require('./verify')` may warn "Cannot find module" — benign.)
- **Config keys may be snake_case (YAML) or camelCase**; constructors normalize both (e.g. `db_path`/`dbPath`). Tolerate both when reading config.
- **CJK-aware everywhere**: token estimation (`core/estimate.ts`), terminal width, and recall tokenization weight Chinese characters specially. Default UI language is `zh`; agents have `systemPrompt`/`systemPromptEn` pairs.
- **Tests use Vitest globals** (`globals: true`) — `describe`/`it`/`expect` need no import, though existing files import them anyway. The agent-loop tests (`tests/agent.test.ts`) drive a scripted `MockLLM` (no network) via `streamWithTools`/`complete`; follow that pattern for loop changes rather than hitting a real provider.
- Path aliases `@skyloom/*` and `@/*` → `src/*` (defined in both `tsconfig.json` and `vitest.config.ts`).
