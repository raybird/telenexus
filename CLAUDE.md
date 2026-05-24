# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeleNexus is a local AI assistant gateway that bridges Telegram to Opencode CLI agent. It provides scheduling, memory management, observability, and a dual-service runner architecture. The project uses TypeScript (ESM) with strict mode, SQLite for persistence, and Docker Compose for deployment.

## Common Commands

```bash
# Development
npm run dev              # Start main TeleNexus service (tsx watch) — runs sync-skills.mjs first
npm run dev:runner       # Start agent-runner service (tsx watch)
npm run build            # TypeScript compile + copy web assets
npm run lint             # ESLint on src/**/*.ts
npm run format           # Prettier on src/**/*.ts and *.md
npm run test             # Run all tests via `tsx --test tests/**/*.test.ts`

# Run a single test (tests may live in nested dirs under tests/)
npx tsx --test tests/memory-manager.test.ts

# Docker
npm run docker:up:build     # Build and start both services
npm run docker:up:meta      # Build with git metadata and force recreate
npm run docker:up:nocache   # Full no-cache rebuild + force recreate
docker compose ps           # Check service status
docker compose logs -f telenexus  # Follow logs

# Memory tooling (require `npm run build` first — these run dist/*)
npm run memory:health              # Memory health report
npm run memory:backfill:dry-run    # Scan archive sessions, no writes
npm run memory:backfill:write      # Apply backfill
npm run memory:cli -- search "..." # Search / forget / inspect memory
npm run memory:seed-sar-anchors    # Seed SAR retrieval anchors

# Reports & release
npm run report:compare           # Execution-comparison report
npm run report:compare:24h       # Last 24h window
npm run release:patch|minor|major  # Bump version + release workflow
```

> `npm run dev`, `start`, and `dev:runner` all auto-run `scripts/sync-skills.mjs` to materialize `skills/` into the workspace before launching.

## Architecture

### Dual-Service Model

The system runs two Docker services that share volumes (`data/`, `workspace/`, `ai-config.yaml`, `skills/`):

- **telenexus** (`src/main.ts`): Orchestrator service — handles Telegram ingress, command routing, scheduling, memory, Web Console, and dispatches AI tasks either locally or to the runner.
- **agent-runner** (`src/runner.ts`): Standalone HTTP service (port 8787) that executes Opencode CLI commands. Provides `/run`, `/health`, and `/stats` endpoints.

Chat traffic routing is controlled by `CHAT_USE_RUNNER_PERCENT` (0-100) with per-user whitelisting. The runner has a circuit breaker pattern (`RUNNER_FAILURE_THRESHOLD` / `RUNNER_COOLDOWN_MS`) with automatic local fallback.

### Message Flow

1. `TelegramConnector` receives message → converts to `UnifiedMessage`
2. `CommandRouter` checks for built-in commands (`/start`, `/reset`, `/new`, `/add_schedule`, `/model`, `/models`, `/set_model`, etc.) or passthrough commands (`/compress`, `/compact`, `/clear` — forwarded to CLI)
3. Non-command messages enter `createMessagePipeline()` which: builds prompt with memory context, routes to appropriate agent (local vs runner), manages thinking-placeholder UX, handles `[[SEND_FILE:]]` directives, and triggers optional summary follow-ups
4. `DynamicAIAgent` reads `ai-config.yaml` at each call and delegates to `OpencodeAgent`
5. Responses are stored in `MemoryManager` (SQLite) and optionally synced to Memoria

### Key Modules

| Path                            | Responsibility                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/core/agent.ts`                    | `AIAgent` interface, `DynamicAIAgent` proxy with runner support and circuit breaker                       |
| `src/core/config-loader.ts`            | Unified AI config reader — merges `ai-config.yaml` + `data/ai-config.override.yaml`; single source of truth for both services |
| `src/core/message-pipeline.ts`         | Main chat pipeline: prompt assembly, execution queue, file directives, image attachment bundling          |
| `src/core/command-router.ts`           | Slash command registry with passthrough whitelist from `ai-config.yaml`                                   |
| `src/core/scheduler.ts`               | Cron-based scheduling with silence-timer reflection system                                                |
| `src/core/memory.ts`                  | `MemoryManager` — SQLite-backed chat history, schedules, and full-text search                             |
| `src/core/execution-queue.ts`         | Per-user priority queue (high/normal/low) ensuring serial execution per user                              |
| `src/core/memoria-sync.ts`            | Background sync bridge to external Memoria CLI for long-term knowledge                                    |
| `src/core/opencode.ts`                | Wraps `opencode run` subprocess calls; fail-fast on upstream 429 via stderr abort pattern                 |
| `src/core/opencode-event-parser.ts`   | Shared Opencode JSON event schema — `interpretEvent()` used by both stream and non-stream paths           |
| `src/core/cli-agent-base.ts`          | Base class for CLI agents: stream lifecycle, heartbeat, smart empty-output classification (`no_events` / `tool_only` / `text_filtered_out`) |
| `src/services/event-bus.ts`           | `emitEvent(type, payload)` — append-only NDJSON to `workspace/context/events.jsonl`; daily rotate + 7-day purge; in-process pub/sub hooks |
| `src/services/event-projector.ts`     | Subscribes to event-bus; triggers immediate context snapshot refresh on key lifecycle events              |
| `src/services/error-alerter.ts`       | Sliding-window error alerter; pushes Telegram message to `ALLOWED_USER_ID` when a scope crosses threshold |
| `src/services/issue-store.ts`         | Persists `recordRuntimeIssue` events to SQLite `runtime_issues` table (7-day retention)                   |
| `src/connectors/telegram.ts`          | Telegraf-based connector implementing `Connector` interface                                               |
| `src/web/server.ts`                   | Built-in Web Console (HTTP, default port 3030)                                                            |
| `src/types/index.ts`                  | Shared interfaces: `UnifiedMessage`, `Connector`, `UserProfile`                                           |

### Configuration

- **`ai-config.yaml`**: Runtime AI provider selection (opencode), model override, passthrough command whitelist, chat prompt assembly config
- **`.env`**: Telegram token, allowed user ID, runner settings, web console settings, Memoria sync options, error alerter / schedule timeout knobs (`ERROR_ALERT_THRESHOLD`, `ERROR_ALERT_WINDOW_MS`, `ERROR_ALERT_COOLDOWN_MS`, `SCHEDULE_TASK_TIMEOUT_MS`)
- **`skills/`**: Skill definitions synced to workspace on startup via `scripts/sync-skills.mjs`; also generates `workspace/context/skills-summary.md` (one-line-per-skill index injected into full prompts)

### Prompt Modes

`src/core/prompt-build.ts` selects one of four modes per turn (rather than always sending full context):

- **full** — periodic full prompt + memory context injection; also injects live system summary (active schedules, recent error count, memory size) and skills index into the prompt so Opencode sees them without needing to read files
- **compact** — lightweight follow-up prompt; memory context only injected when the message clearly needs prior rules/decisions/settings
- **minimal** — short follow-ups, no extra context bloat
- **passthrough** — slash command forwarded verbatim to the underlying CLI, no TeleNexus wrapping

Long-term context comes from two sources: the SQLite memory store (with SAR — Summary-Aware Retrieval) and the optional Memoria CLI background sync.

### Observability

Context snapshots are auto-written to `workspace/context/` as markdown — `runtime-status`, `provider-status`, `scheduler-status`, `error-summary`, `memory-status`, `memoria-status`, `prompt-session-status`, `memory-intent-status`, `runner-status`, plus `runner-audit.log`. Refresh interval is `CONTEXT_REFRESH_MS` (default 60s), but key lifecycle events also trigger an immediate refresh via `event-projector`. The Web Console `#/status` page reads these files directly — they are the canonical system-state view, not `src/`.

**Event stream** — `emitEvent(type, payload)` (`src/services/event-bus.ts`) appends NDJSON to `workspace/context/events.jsonl`. Events are rotated daily and retained for 7 days. `tail -f workspace/context/events.jsonl` shows live lifecycle: `request_start → opencode_start → opencode_done → request_done`. Covered emit points:

- `message-pipeline.ts`: `request_start` / `request_done` / `request_error`
- `opencode.ts`: `opencode_start` / `opencode_done`
- `scheduler.ts`: `schedule_fire` / `schedule_done` / `schedule_fail`
- `runner.ts`: `runner_request_start` / `runner_request_done` / `runner_request_error`
- `errors.ts` (via `recordRuntimeIssue`): `runtime_issue`

**Error pipeline** — `recordRuntimeIssue(scope, err)` fans out to four subscribers:

1. **In-memory** `recentIssues[]` (20-entry buffer, 60s dedupe) — rendered into `error-summary.md`
2. **`IssueStore`** (`src/services/issue-store.ts`) — persists to SQLite `runtime_issues` table; 7-day retention; surfaced as `Past 24h by Scope (persisted)` and `Rate-limit Issues (24h)` in `error-summary.md`
3. **`ErrorAlerter`** (`src/services/error-alerter.ts`) — sliding-window counter per scope; pushes Telegram alert to `ALLOWED_USER_ID` when ≥`ERROR_ALERT_THRESHOLD` events in `ERROR_ALERT_WINDOW_MS`; respects `ERROR_ALERT_COOLDOWN_MS` between alerts
4. **`EventBus`** (`src/services/event-bus.ts`) — emits `runtime_issue` to `events.jsonl` and in-process subscribers

When adding new error handling, always emit `recordRuntimeIssue('<subsystem>:<reason>', err)` rather than only `console.error`, so it lands in all four observability surfaces.

**Empty output handling** — `cli-agent-base.ts` classifies empty stream output into three cases instead of blindly re-running:
- `no_events`: no JSON parsed at all → returns "Opencode 沒有任何輸出，請重試。"
- `tool_only`: tool calls ran but no text reply → sends follow-up in same session
- `text_filtered_out`: text was stripped by `cleanOutput` → returns warning, raw content in verbose log

All three cases emit `recordRuntimeIssue('${provider}:empty-output:${reason}', ...)` for tracking.

### Further Reading

- `ARCHITECTURE.md` — fuller module map and data-flow diagrams
- `docs/configuration-reference.md` — config & runner/session details
- `docs/web-console-reference.md` — Web Console API & views
- `docs/summary-aware-retrieval-plan.md` — memory / SAR design
- `docs/runtime-boundary-and-security.md` — runtime boundary notes
- `AGENTS.md` — soul/style principles for AI behavior in this repo (Traditional Chinese)

## Code Conventions

- ESM modules (`"type": "module"` in package.json, `module: "nodenext"` in tsconfig)
- All imports must use `.js` extension (e.g., `import { Foo } from './foo.js'`)
- TypeScript strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`
- Tests use Node.js built-in `node:test` and `node:assert/strict` — no external test framework
- Commit messages: imperative verb, focused on one topic (e.g., `add command router`, `fix scheduler reload`)
- Primary language for UI strings and comments: Traditional Chinese (Taiwan)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **telenexus** (10891 symbols, 15846 relationships, 298 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/telenexus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/telenexus/clusters` | All functional areas |
| `gitnexus://repo/telenexus/processes` | All execution flows |
| `gitnexus://repo/telenexus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
