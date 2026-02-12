# 配置参考

## 启动入口

| 命令 | 说明 |
|------|------|
| `bun run start` | 默认启动（Telegram bot） |
| `bun run start:telegram` | Telegram bot 入口 |
| `bun run start:wxwork` | 企业微信（WxWork）bot 入口 |

## 环境变量

| 变量 | 必须 | 默认值 | 说明 |
|------|------|--------|------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Telegram Bot Token（从 @BotFather 获取） |
| `AGENT_CWD` | ❌ | `process.cwd()` | Agent 工作目录 |
| `DATA_DIR` | ❌ | `.` | 数据目录（存放 auth.json、models.json、telegram_offset.json） |
| `AUTH_FILE` | ❌ | `{DATA_DIR}/auth.json` | 认证文件路径 |
| `SESSION_DIR` | ❌ | `{DATA_DIR}/sessions` | Agent session 存储目录 |
| `TMUX_SOCKET_DIR` | ❌ | `$TMPDIR/pi-telegram-tmux` | tmux socket 目录 |
| `THINKING_LEVEL` | ❌ | `medium` | 默认思考级别 |
| `OWNER_ID` | ❌ | — | 预设 Owner 的 Telegram user ID（跳过手动配对） |
| `MESSAGE_STORE_ENABLED` | ❌ | `true` | 是否启用消息持久化 |
| `MESSAGE_STORE_MAX_AGE_DAYS` | ❌ | `30` | 消息日志保留天数 |
| `DEBUG_TELEGRAM` | ❌ | `0` | 设为 `1` 启用 Telegram API 响应日志 |

### 企业微信（WxWork）环境变量

| 变量 | 必须 | 默认值 | 说明 |
|------|------|--------|------|
| `WXWORK_CORP_ID` | ✅ | — | 企业微信 Corp ID |
| `WXWORK_CORP_SECRET` | ✅ | — | 企业微信应用 Secret |
| `WXWORK_AGENT_ID` | ✅ | — | 企业微信 Agent ID |
| `WXWORK_TOKEN` | ✅ | — | 回调验证 Token |
| `WXWORK_ENCODING_KEY` | ✅ | — | 回调 EncodingAESKey |
| `WXWORK_PORT` | ❌ | `8080` | Webhook 服务监听端口 |

> 以上变量仅在使用企业微信入口（`bun run start:wxwork`）时需要配置。

### 模型 API Key 环境变量

在 `models.json` 中使用 `"apiKey": "env:VAR_NAME"` 引用，常见的：

- `ANTHROPIC_API_KEY` — Anthropic API key
- `OPENAI_API_KEY` — OpenAI API key
- `DEEPSEEK_API_KEY` — DeepSeek API key
- 自定义名称均可

## 文件

| 文件 | 说明 |
|------|------|
| `models.json` | 模型配置（必须，详见 [models.md](models.md)） |
| `auth.json` | 认证数据（自动生成，支持热重载） |
| `telegram_offset.json` | Telegram polling offset（自动管理） |

## 内部常量

| 常量 | 值 | 位置 | 说明 |
|------|-----|------|------|
| `CONTROLLER_TTL_MS` | 30 分钟 | `index.ts` | 空闲 Controller 自动销毁时间 |
| `CONTROLLER_CLEANUP_INTERVAL_MS` | 5 分钟 | `index.ts` | 清理检查间隔 |
| `telegramMaxChars` | 3800 | `config.ts` | 单条消息最大字符数（低于 Telegram 4096 限制） |
| `editThrottleMs` | 400 | `config.ts` | 流式编辑节流间隔（毫秒） |
| `REQUEST_TIMEOUT_MS` | 60 秒 | `client.ts` | Telegram API 请求超时 |
| `MAX_RETRIES` | 3 | `client.ts` | Telegram API 最大重试次数 |
| `BASE_RETRY_DELAY_MS` | 1000 | `client.ts` | 重试基础延迟（指数退避） |

## Skills 配置

Agent 的 skill 从以下路径加载：

1. `{AGENT_CWD}/.agents/skills/`
2. `$HOME/.agents/skills/`

通过 SDK 的 `DefaultResourceLoader` 配置，设置 `noSkills: true` 禁用默认路径，`additionalSkillPaths` 指定自定义路径。

项目根目录的 `pi-skills/` 是 git submodule，包含多个 skill 包（brave-search、browser-tools、gccli 等），需手动符号链接或复制到上述路径才会被加载。
