# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram/WxWork bot frontend for the Pi coding agent (`@mariozechner/pi-coding-agent` SDK). Users chat with an AI agent that has file access, bash execution, and tmux terminal control.

## Build & Development Commands

```bash
# Install dependencies
bun install

# Development (Telegram)
bun run dev              # or dev:telegram

# Development (WxWork)
bun run dev:wxwork

# Production
bun run start            # Telegram
bun run start:wxwork     # WxWork

# Build
bun run build            # Outputs to ./dist

# Watchdog (production with auto-rollback)
./watchdog.sh
```

## Configuration

**Required files:**
- `.env` — Copy from `.env.example`, set `TELEGRAM_BOT_TOKEN`
- `models.json` — Copy from `models.json.example`, configure at least one model

**Key environment variables:**
- `TELEGRAM_BOT_TOKEN` — Required for Telegram
- `AGENT_CWD` — Agent working directory (default: current dir)
- `DATA_DIR` — Data directory for auth.json, models.json (default: `.`)
- `SESSION_DIR` — Agent session storage (default: `{DATA_DIR}/sessions`)
- `OWNER_ID` — Pre-configured owner Telegram user ID (skips manual pairing)

**WxWork-specific (only for `start:wxwork`):**
- `WXWORK_CORP_ID`, `WXWORK_CORP_SECRET`, `WXWORK_AGENT_ID`, `WXWORK_TOKEN`, `WXWORK_ENCODING_KEY`

## Architecture Overview

### Three-Layer Architecture

```
Transport Layer (Platform Inbound)
  Telegram: Long polling → InboundEvent
  WxWork:   Webhook (Bun.serve) → InboundEvent
           ↓
Core Bot Layer (Platform-Agnostic)
  Router → AuthStore → ChatController → Agent SDK
                        ↕
              TmuxHandler, StreamSink
           ↓
Messenger Layer (Platform Outbound)
  Telegram: HTML parse_mode, inline keyboards, draft/edit
  WxWork:   Markdown, simple messages (no edit/buttons)
```

### Key Abstractions (`src/im/`)

- `Messenger` — Send/edit/delete messages, inline buttons
- `Formatter` — Platform-specific formatting (bold/code/pre/escape)
- `StreamSink` — Stream buffering and output
- `ConversationRef` — Cross-platform conversation ID

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/bot/router.ts` | Auth, controller lifecycle, per-conversation promise queues |
| `src/bot/controller.ts` | Command routing, agent events, UI building |
| `src/bot/tmux-handler.ts` | tmux terminal mode and session management |
| `src/agent/session.ts` | SDK session wrapper, event bridging, model fallback |
| `src/models.ts` | Multi-model registry and ModelStore |
| `src/auth.ts` | Owner pairing and user authorization |

### Platform Adapters (`src/platforms/`)

- `telegram/` — Long polling transport, HTML formatter, inline keyboards, draft/edit streaming
- `wxwork/` — Webhook server, Markdown formatter, AES-256-CBC crypto, buffered output (no edits)

### Data Flow

1. Platform receives message → converts to `InboundEvent`
2. `Router.handleEvent()` → auth check → enqueue to per-conversation queue
3. `ChatController` → `ManagedSession.prompt()` → SDK AgentSession
4. SDK events → callbacks → `StreamSink` → platform messenger

## Model Configuration

Models are configured in `models.json`:

```json
{
  "defaultModel": "sonnet4",
  "models": [
    {
      "key": "sonnet4",
      "label": "Claude Sonnet 4",
      "provider": "anthropic",
      "id": "claude-sonnet-4-20250514",
      "thinkingLevel": "medium"
    }
  ]
}
```

- Use `"apiKey": "env:VAR_NAME"` to reference environment variables
- Custom models need `apiFormat` ("anthropic-messages" or "openai-completions")
- Model fallback: on recoverable errors, automatically switches to default model

## Key Design Patterns

**Queue Serialization:** Each `conversationId:threadId` has an independent promise queue guaranteeing strict ordering.

**Lazy Initialization:** `ChatController` creates `ManagedSession` on first interaction, not at construction.

**Interface Isolation:** Core logic in `bot/` only depends on `im/` interfaces, never platform-specific code.

**Controller Lifecycle:** Controllers auto-dispose after 30 minutes idle (`CONTROLLER_TTL_MS`).

## Important Constants

| Constant | Value | Location |
|----------|-------|----------|
| Controller TTL | 30 min | `index.ts`, `router.ts` |
| Telegram max chars | 3800 | `config.ts` (below 4096 limit) |
| Edit throttle | 400ms | `config.ts` |
| API timeout | 60s | `telegram/client.ts` |

## Skills

Agent skills load from:
1. `{AGENT_CWD}/.agents/skills/`
2. `$HOME/.agents/skills/`

The `pi-skills/` directory is a git submodule with skill packages (brave-search, browser-tools, etc.). Link or copy to one of the paths above to enable.
