# Pi Agent Bot — Agent Notes

## Commands
- `bun install` — install deps
- `bun run start` — run legacy Telegram bot (`src/index.ts`)
- `bun run start:telegram` — run Telegram bot (new entry, `src/main-telegram.ts`)
- `bun run start:wxwork` — run WxWork bot (`src/main-wxwork.ts`)
- `bun run dev` / `bun run dev:telegram` / `bun run dev:wxwork` — watch mode
- `bun run build` / `bun run build:telegram` / `bun run build:wxwork` — bundle to `dist/`
- No test suite exists yet.

## Architecture
Multi-platform AI coding agent frontend (Telegram + WxWork/企业微信) using 3-layer architecture.

### Core Abstractions (`src/im/`)
- `types.ts` — `ConversationRef`, `UserRef`, `InboundEvent`, `ImageData`
- `messenger.ts` — `Messenger`, `UIButton`, `UIElement`, `OutMessage`
- `formatter.ts` — `Formatter` interface (bold/code/pre/escape)
- `stream-sink.ts` — `StreamSink` interface

### Bot Layer (`src/bot/`) — platform-agnostic
- `router.ts` — auth checks, controller lifecycle (30min TTL), queue serialization
- `controller.ts` — `ChatController` with Messenger/Formatter/StreamSink (no platform imports)
- `tmux-handler.ts` — tmux terminal mode using Messenger/Formatter

### Platform Adapters (`src/platforms/`)
- **`telegram/`** — HTML formatter, TelegramMessenger (inline keyboard, edit, draft), draft/edit StreamSink, long-polling transport
- **`wxwork/`** — Markdown formatter, WxWorkMessenger (text/image/file API), buffered StreamSink, webhook transport (Bun.serve), AES crypto

### Entry Points
- `src/main-telegram.ts` — Telegram entry (new architecture)
- `src/main-wxwork.ts` — WxWork entry
- `src/index.ts` — legacy Telegram entry (still works)

### Shared
- **`src/agent/session.ts`** — wraps `@mariozechner/pi-coding-agent` SDK; creates agent sessions, bridges events
- **`src/tmux/`** — tmux process management (`tmux.ts`) and agent tool definitions (`tools.ts`)
- **`src/auth.ts`** — owner-pairing auth store persisted to `auth.json` with file-watch hot-reload
- **`src/config.ts` / `src/models.ts`** — env-driven config, multi-model registry loaded from `models.json`
- **`src/telegram/`** — low-level Telegram Bot API client (used by `platforms/telegram/`)
- **`pi-skills/`** — custom Pi agent skill definitions

## Documentation
- **[docs/architecture.md](docs/architecture.md)** — 系统架构、模块结构、数据流、设计模式
- **[docs/config.md](docs/config.md)** — 环境变量、文件、内部常量、Skills 配置
- **[docs/auth.md](docs/auth.md)** — 认证系统（owner pairing、用户管理、热重载）
- **[docs/models.md](docs/models.md)** — 模型配置、API key 解析、模型降级、Telegram UI
- **[docs/streaming.md](docs/streaming.md)** — 流式输出（Draft/Edit 模式、节流、分块）
- **[docs/sessions.md](docs/sessions.md)** — Agent 会话管理（自动恢复、切换、消息持久化）
- **[docs/tmux.md](docs/tmux.md)** — tmux 终端功能（命令、Topic 直连、Agent 工具、Keyboard）
- **[docs/telegram-client.md](docs/telegram-client.md)** — Telegram 客户端（API、重试、Scoped Client、格式化、Keyboard）

### ⚠️ 文档同步规则
**每次修改代码后，必须同步更新 `docs/` 下对应的文档**，确保文档与代码一致。对照表：
- `src/index.ts` → `docs/architecture.md`, `docs/auth.md`
- `src/config.ts` → `docs/config.md`
- `src/models.ts` → `docs/models.md`
- `src/auth.ts` → `docs/auth.md`
- `src/agent/session.ts` → `docs/models.md`, `docs/architecture.md`, `docs/sessions.md`
- `src/session/controller.ts` → `docs/architecture.md`, `docs/sessions.md`, `docs/streaming.md`
- `src/session/controller/streaming.ts` → `docs/streaming.md`
- `src/session/controller/tmux-handler.ts` → `docs/tmux.md`
- `src/tmux/` → `docs/tmux.md`
- `src/telegram/` → `docs/telegram-client.md`
- `src/im/` → `docs/architecture.md`
- `src/bot/` → `docs/architecture.md`
- `src/platforms/telegram/` → `docs/architecture.md`, `docs/streaming.md`
- `src/platforms/wxwork/` → `docs/architecture.md`, `docs/config.md`
- `src/main-telegram.ts` → `docs/architecture.md`
- `src/main-wxwork.ts` → `docs/architecture.md`, `docs/config.md`

## Code Style
- TypeScript with Bun runtime; ESM (`"type": "module"`), `.js` extensions in imports
- Explicit interface definitions; avoid `any` (except SDK boundary casts)
- `node:` prefix for Node built-ins (`node:fs`, `node:path`)
- Use HTML `parse_mode` for Telegram messages; escape with `escapeHtml`
- Error handling: try/catch with `console.error`, never throw unhandled in async loops
- Naming: PascalCase classes, camelCase functions/variables, UPPER_SNAKE env vars
