# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeleNexus is a local AI assistant gateway that bridges Telegram to local AI CLI agents (Gemini CLI / Opencode). It provides scheduling, memory management, observability, and a dual-service runner architecture. The project uses TypeScript (ESM) with strict mode, SQLite for persistence, and Docker Compose for deployment.

## Common Commands

```bash
# Development
npm run dev              # Start main TeleNexus service (tsx watch)
npm run dev:runner       # Start agent-runner service (tsx watch)
npm run build            # TypeScript compile + copy web assets
npm run lint             # ESLint on src/**/*.ts
npm run format           # Prettier on src/**/*.ts and *.md
npm run test             # Run all tests (Node.js built-in test runner via tsx)

# Run a single test
npx tsx --test tests/memory-manager.test.ts

# Docker
npm run docker:up:build  # Build and start both services
npm run docker:up:meta   # Build with git metadata and force recreate
docker compose ps        # Check service status
docker compose logs -f telenexus  # Follow logs
```

## Architecture

### Dual-Service Model

The system runs two Docker services that share volumes (`data/`, `workspace/`, `ai-config.yaml`, `skills/`):

- **telenexus** (`src/main.ts`): Orchestrator service — handles Telegram ingress, command routing, scheduling, memory, Web Console, and dispatches AI tasks either locally or to the runner.
- **agent-runner** (`src/runner.ts`): Standalone HTTP service (port 8787) that executes AI CLI commands (Gemini/Opencode). Provides `/run`, `/health`, and `/stats` endpoints. Serializes Gemini requests via an execution queue.

Chat traffic routing is controlled by `CHAT_USE_RUNNER_PERCENT` (0-100) with per-user whitelisting. The runner has a circuit breaker pattern (`RUNNER_FAILURE_THRESHOLD` / `RUNNER_COOLDOWN_MS`) with automatic local fallback.

### Message Flow

1. `TelegramConnector` receives message → converts to `UnifiedMessage`
2. `CommandRouter` checks for built-in commands (`/start`, `/reset`, `/new`, `/add_schedule`, etc.) or passthrough commands (`/compress`, `/compact`, `/clear` — forwarded to CLI)
3. Non-command messages enter `createMessagePipeline()` which: builds prompt with memory context, routes to appropriate agent (local vs runner), manages thinking-placeholder UX, handles `[[SEND_FILE:]]` directives, and triggers optional summary follow-ups
4. `DynamicAIAgent` reads `ai-config.yaml` at each call to select provider (gemini/opencode) and delegates to `GeminiAgent` or `OpencodeAgent`
5. Responses are stored in `MemoryManager` (SQLite) and optionally synced to Memoria

### Key Modules

| Path | Responsibility |
|------|----------------|
| `src/core/agent.ts` | `AIAgent` interface, `DynamicAIAgent` proxy with runner support and circuit breaker |
| `src/core/message-pipeline.ts` | Main chat pipeline: prompt assembly, execution queue, file directives, image attachment bundling |
| `src/core/command-router.ts` | Slash command registry with passthrough whitelist from `ai-config.yaml` |
| `src/core/scheduler.ts` | Cron-based scheduling with silence-timer reflection system |
| `src/core/memory.ts` | `MemoryManager` — SQLite-backed chat history, schedules, and full-text search |
| `src/core/execution-queue.ts` | Per-user priority queue (high/normal/low) ensuring serial execution per user |
| `src/core/memoria-sync.ts` | Background sync bridge to external Memoria CLI for long-term knowledge |
| `src/core/gemini.ts` | Wraps `gemini-cli` subprocess calls |
| `src/core/opencode.ts` | Wraps `opencode run` subprocess calls |
| `src/connectors/telegram.ts` | Telegraf-based connector implementing `Connector` interface |
| `src/web/server.ts` | Built-in Web Console (HTTP, default port 3030) |
| `src/types/index.ts` | Shared interfaces: `UnifiedMessage`, `Connector`, `UserProfile` |

### Configuration

- **`ai-config.yaml`**: Runtime AI provider selection (`gemini` / `opencode`), model override, passthrough command whitelist, chat prompt assembly config
- **`.env`**: Telegram token, allowed user ID, runner settings, web console settings, Memoria sync options
- **`skills/`**: Skill definitions synced to workspace on startup via `scripts/sync-skills.mjs`

### Observability

Context snapshots are auto-written to `workspace/context/` (runtime, provider, scheduler, error, runner status as markdown). Refresh interval is controlled by `CONTEXT_REFRESH_MS` (default 60s). The runner writes audit logs to `workspace/context/runner-audit.log`.

## Code Conventions

- ESM modules (`"type": "module"` in package.json, `module: "nodenext"` in tsconfig)
- All imports must use `.js` extension (e.g., `import { Foo } from './foo.js'`)
- TypeScript strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`
- Tests use Node.js built-in `node:test` and `node:assert/strict` — no external test framework
- Commit messages: imperative verb, focused on one topic (e.g., `add command router`, `fix scheduler reload`)
- Primary language for UI strings and comments: Traditional Chinese (Taiwan)
