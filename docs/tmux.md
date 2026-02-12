# tmux 功能文档

## 概述

通过 Telegram 远程操控服务器上的 tmux 会话。支持两种使用方式：Telegram 命令和 Forum Topic 直连模式。

## 源文件

| 文件 | 职责 |
|------|------|
| `src/tmux/tmux.ts` | 底层 tmux 命令封装（`execFile` 调用） |
| `src/tmux/tools.ts` | Pi Agent SDK 工具定义，让 AI agent 自主控制 tmux |
| `src/session/controller.ts` | ChatController 命令路由和回调分发 |
| `src/session/controller/tmux-handler.ts` | `TmuxHandler` 类，所有 tmux 交互逻辑的核心实现 |
| `src/telegram/keyboards.ts` | tmux 相关的 inline keyboard 构建器 |
| `src/index.ts` | `/tmux` topic 检测与消息路由 |

## 底层 API（`src/tmux/tmux.ts`）

所有 tmux 操作通过指定的 socket 路径执行，函数列表：

- `listSessions(opts)` — 列出所有会话
- `newSession(opts, name, command?)` — 创建新会话
- `killSession(opts, name)` — 终止会话
- `sendKeys(opts, target, keys, literal?)` — 发送按键
- `sendEnter(opts, target)` — 发送回车
- `sendCtrlC(opts, target)` — 发送 Ctrl-C
- `capturePane(opts, target, lines?)` — 捕获面板输出（默认 200 行）
- `listWindows(opts, session)` — 列出会话中的窗口
- `hasSession(opts, name)` — 检查会话是否存在
- `resizeWindow(opts, target, cols, rows)` — 调整窗口大小
- `getWindowSize(opts, target)` — 获取窗口大小（cols × rows）
- `ensureSocketDir(dir)` — 确保 socket 目录存在

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/tmux` | 进入交互式终端模式，显示会话列表（带 inline 按钮） |
| `/new <name>` | 创建新 tmux 会话 |
| `/select <name>` | 选择当前活跃会话 |
| `/capture [name]` | 捕获面板输出 |
| `/send <text>` | 向选中面板发送按键 |
| `/ctrlc` | 向选中面板发送 Ctrl-C |
| `/kill [name]` | 终止会话 |
| `/resize [CxR]` | 调整窗口大小（如 `/resize 45x60`），无参数时显示预设按钮 |

## Forum Topic 直连模式

### 工作原理

在 Telegram 群组（Forum 模式）中创建一个名称以 `/tmux` 开头的 Topic，即可将该 Topic 变为 tmux 终端直连通道。

### 消息路由流程

1. **检测**（`src/index.ts`）：从 `msg.reply_to_message.forum_topic_created.name` 或 `msg.forum_topic_created.name` 获取 topic 名称
2. **判断**：topic 名称以 `/tmux` 开头 → `isTmuxTopic = true`
3. **路由**：非命令消息（不以 `/` 开头）→ `ChatController.handleTmuxTopicMessage(text)`
4. **执行**：`sendKeys` + `sendEnter` 将文本发送到 `selectedSession:0.0`
5. **回显**：延迟 500ms 后自动 capture 面板输出并发送回 Telegram

### 自动回显机制

- 每次用户在 topic 中发送文本后，自动调用 `tmuxTopicCapture()` 显示终端输出
- 显示格式与 `/capture` 命令一致，包含 `tmuxTerminalKeyboard` 按钮（刷新、Ctrl-C、Enter、上下箭头、Tab、切换会话）
- 每次回显前会**删除上一条 capture 消息**，避免聊天中堆积大量输出消息
- 通过 `lastCaptureMsgId` 跟踪上一条 capture 消息 ID

### 使用步骤

1. 在 Telegram 群组中启用 Forum 模式
2. 创建 Topic，名称设为 `/tmux`（或 `/tmux xxx`）
3. 首次发消息时会提示选择 tmux 会话
4. 之后直接在 topic 中打字即可输入终端命令，自动回显输出

## Inline Keyboard

### `tmuxSessionsKeyboard`
显示会话列表（每行最多 2 个），底部有「新建会话」和「刷新」按钮。

### `tmuxSessionActionsKeyboard`
单个会话的操作按钮：Capture、Send Keys、Ctrl-C、Kill、返回列表。

### `tmuxTerminalKeyboard`
终端模式按钮：🔄 Refresh、🛑 Ctrl-C、⏎ Enter、📟 Switch、⬆️ Up、⬇️ Down、⇥ Tab、📐 Resize。

### `tmuxResizeKeyboard`
窗口大小预设按钮：📱 Mobile (45×60)、📱 Narrow (35×80)、🖥 Standard (80×24)、🖥 Wide (120×40)、◀️ Back。

## Agent 工具（`src/tmux/tools.ts`）

注册到 Pi Agent SDK 的工具，让 AI 可以自主操作 tmux：

- `tmux_list_sessions` — 列出会话
- `tmux_new_session` — 创建会话
- `tmux_kill_session` — 终止会话
- `tmux_send_keys` — 发送按键（支持 literal 模式和控制键）
- `tmux_capture_pane` — 捕获面板输出
- `tmux_list_windows` — 列出窗口
- `tmux_send_ctrl_c` — 发送 Ctrl-C

## TmuxHandler 状态

`TmuxHandler`（`src/session/controller/tmux-handler.ts`）中与 tmux 相关的状态字段：

- `tmuxSocket: string` — tmux socket 路径
- `tmuxSocketDir: string` — socket 目录路径
- `selectedSession: string | null` — 当前选中的会话名
- `isTmuxThread: boolean` — 是否处于 `/tmux` 交互模式
- `lastCaptureMsgId: number | null` — 上一条 capture 消息 ID，用于 topic 模式下删除旧消息、终端模式下编辑更新

## 两种终端模式对比

| 特性 | `/tmux` 交互模式 | Forum Topic 直连模式 |
|------|------------------|---------------------|
| 入口 | 执行 `/tmux` 命令 | 创建名为 `/tmux*` 的 Topic |
| 消息处理 | `tmuxTerminalSend()` | `handleTmuxTopicMessage()` |
| 回显延迟 | 300ms | 500ms |
| 旧消息处理 | 编辑更新（`editMessageText`） | 删除旧消息再发新消息（`deleteMessage`） |
| 状态标志 | `isTmuxThread = true` | 由 `index.ts` 路由检测 |
| 会话不存在时 | 调用 `tmuxTerminalPickSession()` | 调用 `promptSelectTmuxSession()` |
