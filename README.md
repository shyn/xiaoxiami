# Pi Agent Telegram Bot

A Telegram bot frontend for the Pi coding agent with tmux integration. Chat with an AI agent, control tmux sessions, and orchestrate interactive CLIs — all from Telegram.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get the token
2. Configure environment:

```bash
cp .env.example .env
# Edit .env with your bot token
```

3. Install and run:

```bash
bun install
bun run start
```

4. Send `/start` to your bot in Telegram — the first user to do so becomes the **owner**
5. The owner can add other users with `/adduser <user_id>`

Auth state is persisted to `auth.json` (configurable via `AUTH_FILE`). Edit it directly for hot-reload, or use the bot commands.

## Commands

### Agent
- **Any text message** — Prompt the AI agent
- `/reset` — Reset agent session
- `/abort` — Abort current operation
- `/status` — Show status

### tmux
- `/tmux` — List sessions (with inline buttons)
- `/new <name>` — Create a new tmux session
- `/select <name>` — Select active session
- `/capture [name]` — Capture pane output
- `/send <text>` — Send keystrokes to selected pane
- `/ctrlc` — Send Ctrl-C to selected pane
- `/kill [name]` — Kill a session

### User Management (owner only)
- `/adduser <user_id>` — Allow another user
- `/removeuser <user_id>` — Remove a user
- `/users` — List allowed users

## Architecture

```
Telegram ←→ ChatController ←→ Pi Agent SDK
                ↕
              tmux
```

- **Telegram client**: Minimal fetch-based Bot API client (long polling)
- **ChatController**: Per-chat orchestrator handling streaming, chunking, and tmux context
- **Pi Agent SDK**: Manages the AI agent session with tmux tools registered as custom tools
- **tmux tools**: Registered with the agent so it can autonomously create sessions, send keys, capture output, etc.

## Features

- Streaming agent output edited into Telegram messages (throttled)
- Automatic message chunking for long outputs (>4096 chars → sent as file)
- Inline keyboards for tmux session management
- Agent can autonomously control tmux (create sessions, send commands, capture output)
- Direct tmux commands for manual control
- Owner pairing auth with multi-user support (`/adduser`, `/removeuser`)
- Steer/interrupt the agent while it's running
- Multi-model support with runtime switching and automatic fallback
- Image input support (send photos to the agent)
- Forum Topic support (dedicated tmux terminals per topic)
- Message persistence (JSONL daily rotation with auto-cleanup)

## Documentation

See the [docs/](docs/) directory for detailed documentation:

- [architecture.md](docs/architecture.md) — 系统架构概览
- [config.md](docs/config.md) — 配置参考（环境变量、文件、常量）
- [auth.md](docs/auth.md) — 认证系统（owner pairing、用户管理）
- [models.md](docs/models.md) — 模型配置与切换
- [streaming.md](docs/streaming.md) — 流式输出机制
- [sessions.md](docs/sessions.md) — Agent 会话管理
- [tmux.md](docs/tmux.md) — tmux 终端功能
- [telegram-client.md](docs/telegram-client.md) — Telegram 客户端与 UI 组件
