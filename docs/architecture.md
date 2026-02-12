# 系统架构

## 概述

Pi Agent Bot 是一个多平台 AI 编程助手前端，封装了 `@mariozechner/pi-coding-agent` SDK。支持 Telegram 和企业微信（WxWork）平台。用户通过 IM 与 AI agent 对话，agent 拥有文件读写、bash 执行、tmux 终端控制等工具能力。

## 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Transport Layer（平台入站）                                  │
│  Telegram: Long Polling → InboundEvent                      │
│  WxWork:   Webhook (Bun.serve) → InboundEvent               │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│  Core Bot Layer（平台无关）                                   │
│  Router → AuthStore → ChatController → Agent SDK            │
│                       ↕                                     │
│              TmuxHandler  StreamSink                         │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│  Messenger Layer（平台出站）                                  │
│  Telegram: HTML parse_mode, inline keyboard, draft/edit     │
│  WxWork:   Markdown, 应用消息 API, 无编辑/按钮              │
└─────────────────────────────────────────────────────────────┘
```

## 核心抽象 (src/im/)

| 接口 | 文件 | 职责 |
|------|------|------|
| `Messenger` | `messenger.ts` | 发送消息、编辑、删除、确认按钮、发草稿 |
| `Formatter` | `formatter.ts` | 平台格式化（bold/code/pre/link/escape） |
| `StreamSink` | `stream-sink.ts` | 流式输出缓冲与发送 |
| `ConversationRef` | `types.ts` | 跨平台会话标识（platform, conversationId, threadId） |
| `InboundEvent` | `types.ts` | 统一入站事件（text, command, image, action） |

## 模块结构

```
src/
├── main-telegram.ts            # Telegram 入口
├── main-wxwork.ts              # WxWork 入口
├── index.ts                    # 旧版 Telegram 入口（保留兼容）
├── config.ts                   # 环境变量加载
├── models.ts                   # 多模型注册与管理
├── auth.ts                     # 认证存储（owner pairing + 用户授权）
├── im/                         # 平台抽象接口
│   ├── types.ts                # ConversationRef, UserRef, InboundEvent, ImageData
│   ├── messenger.ts            # Messenger, UIButton, UIElement, OutMessage
│   ├── formatter.ts            # Formatter 接口
│   ├── stream-sink.ts          # StreamSink 接口
│   └── index.ts                # Re-exports
├── bot/                        # 平台无关核心逻辑
│   ├── router.ts               # Router：认证、Controller 生命周期、队列序列化
│   ├── controller.ts           # ChatController：命令路由、agent 事件、UI 构建
│   ├── tmux-handler.ts         # TmuxHandler：tmux 终端模式与会话管理
│   └── index.ts                # Re-exports
├── platforms/
│   ├── telegram/               # Telegram 平台适配
│   │   ├── formatter.ts        # HTML 格式化
│   │   ├── messenger.ts        # TelegramMessenger（inline keyboard, edit, draft）
│   │   ├── stream-sink.ts      # Draft/edit 模式流式输出
│   │   ├── transport.ts        # Long polling + InboundEvent 转换
│   │   └── index.ts
│   └── wxwork/                 # WxWork（企业微信）平台适配
│       ├── client.ts           # WxWork API 客户端（access token, 消息发送）
│       ├── crypto.ts           # 回调消息加解密（AES-256-CBC + 签名校验）
│       ├── formatter.ts        # Markdown 格式化
│       ├── messenger.ts        # WxWorkMessenger（文本/图片/文件）
│       ├── stream-sink.ts      # 缓冲式输出（无编辑，仅最终发送）
│       ├── transport.ts        # Webhook 服务器（Bun.serve）
│       └── index.ts
├── agent/
│   └── session.ts              # ManagedSession：SDK 会话封装与事件桥接
├── telegram/                   # 底层 Telegram API 客户端（被 platforms/telegram/ 引用）
│   ├── client.ts               # Telegram Bot API 客户端（fetch + 重试）
│   ├── format.ts               # HTML 格式化工具
│   ├── keyboards.ts            # Inline Keyboard 构建器
│   ├── callback-parser.ts      # 回调数据解析与验证
│   └── store.ts                # JSONL 消息持久化
└── tmux/
    ├── tmux.ts                 # 底层 tmux 命令封装
    └── tools.ts                # Agent SDK 工具定义
```

## 核心数据流

### 1. 消息处理流程

```
Platform Transport (Telegram/WxWork)
  → InboundEvent
    → Router.handleEvent()
      → 认证检查（auth commands 优先处理）
      → enqueue() — 放入 per-conversation promise 队列
        → ChatController.handleMessage() / handleCommand() / handleCallback()
          → ManagedSession.prompt() — 发送给 agent
            → SDK AgentSession — 调用 LLM、执行工具
              → 事件回调 → StreamSink 输出到 IM
```

### 2. Agent 事件桥接

SDK `AgentSession` 通过 `session.subscribe()` 发出事件，在 `session.ts` 中桥接到 `AgentEventCallbacks`：

| SDK 事件 | 回调 | 处理 |
|----------|------|------|
| `message_update` (text_delta) | `onTextDelta` | StreamSink 累积并输出 |
| `message_update` (thinking_delta) | `onThinkingDelta` | 当前忽略（noop） |
| `tool_execution_start` | `onToolStart` | 发送工具执行通知 |
| `tool_execution_end` | `onToolEnd` | 仅在错误时发送通知 |
| `agent_start` | `onAgentStart` | 重置流状态、标记 isAgentRunning |
| `agent_end` | `onAgentEnd` | 最终化流输出、处理待处理消息 |

### 3. Controller 生命周期

```
首次消息 → ensureInitialized()
  → init()
    → 创建 tmux 工具
    → 创建 ManagedSession
    → 自动恢复最新 session（如存在）
  → 缓存到 controllers Map

空闲 30 分钟 → Router.cleanupStaleControllers()
  → controller.dispose()
  → 从 Map 中移除
```

## 平台差异对照

| 特性 | Telegram | WxWork |
|------|----------|--------|
| 入站方式 | Long Polling | Webhook (HTTP POST) |
| 消息格式 | HTML parse_mode | Markdown 子集 |
| 消息长度限制 | ~3800 chars | ~1800 chars (2048 bytes) |
| 消息编辑 | ✅ | ❌ |
| 草稿消息 | ✅ | ❌ |
| 内联按钮 | ✅ inline_keyboard | ❌ |
| 删除消息 | ✅ | ❌ |
| 话题/线程 | ✅ Forum Topics | ❌ |
| 流式输出 | Draft + Edit 模式 | 仅最终发送 |
| 回调加密 | 无 | AES-256-CBC + SHA1 签名 |

## 关键设计模式

### 队列序列化
每个 `conversationId:threadId` 有独立的 promise 队列，保证同一对话中的消息严格顺序处理。

### 延迟初始化
`ChatController` 创建时不初始化 agent session，首次交互时才通过 `ensureInitialized()` 创建 `ManagedSession`。

### 接口隔离
核心逻辑仅依赖 `im/` 接口，不导入任何平台包。平台适配器实现接口并在入口文件中注入。

### 模型降级
当 agent 遇到可恢复错误时，自动切换到默认模型并通知用户。详见 [models.md](models.md)。

## 依赖关系

| 包 | 用途 |
|----|------|
| `@mariozechner/pi-coding-agent` | Agent SDK：会话管理、工具执行、模型注册 |
| `@mariozechner/pi-ai` | AI 模型抽象层 |
| `@sinclair/typebox` | JSON Schema 构建器，用于定义 tmux 工具参数 |
