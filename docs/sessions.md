# Agent 会话管理

## 概述

Agent 会话通过 SDK 的 `SessionManager` 持久化到文件系统。每个 Telegram chat/thread 有独立的 session 目录，支持多会话切换和恢复。

## 源文件

- `src/session/controller.ts` — 会话 UI 交互（`showAgentSessions`、`resumeAgentSession`、`startNewAgentSession`）
- `src/agent/session.ts` — `ManagedSession.switchSession()`

## Session 目录

```
{SESSION_DIR}/
├── {chatId}/                    # 私聊
│   ├── session-xxx.json
│   └── session-yyy.json
├── {chatId}_{threadId}/         # Forum Topic
│   └── session-zzz.json
```

`SESSION_DIR` 默认为 `{DATA_DIR}/sessions`，可通过环境变量 `SESSION_DIR` 配置。

## 自动恢复

Controller 初始化时（`init(autoResume=true)`）：

1. 调用 `SessionManager.list()` 获取所有会话
2. 按修改时间降序排序
3. 恢复最近的会话（`switchSession()`）
4. 恢复后重新应用当前模型设置

`/reset` 命令调用 `init(autoResume=false)` 跳过自动恢复。

## 命令

| 命令 | 说明 |
|------|------|
| `/sessions` | 显示会话列表（分页，每页 8 个） |
| `/resume [id]` | 恢复指定会话；无参数时等同 `/sessions` |
| `/newsession` | 创建新的空会话 |
| `/reset` | 完全重置（销毁 ManagedSession → 重新初始化 → 创建新会话） |

## Inline Keyboard

### 会话列表

每个会话显示为一行按钮，格式：`{日期} · {名称/首条消息}` + 当前会话标记 `✦`

底部按钮：
- ➕ New Session — `sess:new`
- 📄 More — `sess:more`（有更多页时显示）
- 🔄 Refresh — `sess:refresh`

### Callback 数据

| 格式 | 操作 |
|------|------|
| `sess:switch:{id}` | 切换到指定会话 |
| `sess:new` | 创建新会话 |
| `sess:more` | 显示下一页 |
| `sess:refresh` | 刷新列表 |

## 切换限制

- Agent 运行中不能切换或创建新会话，需先 `/abort`
- 切换会话时重置 `StreamingManager` 状态和 `pendingInput`
- 切换后重新应用模型设置（`reapplyModel()`）

## 消息持久化（TelegramMessageStore）

独立于 agent session，用于持久化原始 Telegram update：

- 每个 chat/thread 每天一个 JSONL 文件：`{date}.jsonl`
- 可通过 `MESSAGE_STORE_ENABLED=false` 禁用
- 自动清理超过 `MESSAGE_STORE_MAX_AGE_DAYS`（默认 30 天）的旧文件
- 清理检查间隔：每小时最多一次
