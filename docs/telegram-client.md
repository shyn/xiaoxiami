# Telegram 客户端

## 概述

基于 `fetch` 的 Telegram Bot API 客户端，支持自动重试、超时控制、Forum Topic scoped client。

## 源文件

- `src/telegram/client.ts` — API 客户端与类型定义
- `src/telegram/format.ts` — HTML 格式化
- `src/telegram/keyboards.ts` — Inline Keyboard 构建
- `src/telegram/callback-parser.ts` — Callback 数据解析

## API 方法

| 方法 | 说明 |
|------|------|
| `sendMessage` | 发送消息（支持 HTML、inline keyboard、link preview） |
| `editMessageText` | 编辑消息文本 |
| `deleteMessage` | 删除消息 |
| `sendPhoto` | 发送图片（支持 file_id 字符串或 Uint8Array 二进制） |
| `sendDocument` | 发送文件（FormData 上传） |
| `answerCallbackQuery` | 应答回调查询 |
| `getUpdates` | 长轮询获取更新 |
| `sendMessageDraft` | 发送草稿消息（用于流式显示） |
| `sendChatAction` | 发送聊天动作（如 typing） |
| `deleteWebhook` | 删除 Webhook |
| `setMyCommands` | 设置 Bot 命令列表 |
| `getFile` | 获取文件信息 |
| `downloadFile` | 下载文件内容 |

## 重试机制

### 可重试条件

- HTTP 429（Rate Limit）：使用 `retry_after` 延迟
- HTTP 5xx（服务器错误）：指数退避
- 网络错误（`fetch failed`、`ECONNREFUSED` 等）：指数退避
- 超时（非长轮询）：直接重试

### 退避策略

```
delay = retry_after * 1000                    // 429 有 retry_after 时
delay = BASE_RETRY_DELAY_MS * 2^attempt       // 其他情况（1s, 2s, 4s）
```

最多重试 `MAX_RETRIES`（3）次。

### 长轮询特殊处理

- 超时时间 = `timeout * 1000 + 15000`（额外 15 秒缓冲）
- 超时不重试（直接抛出）

## Scoped Client

`scopedClient(client, threadId)` 返回一个代理 client，自动为以下方法注入 `message_thread_id`：

- `sendMessage`
- `editMessageText`
- `sendPhoto`
- `sendDocument`
- `sendMessageDraft`
- `sendChatAction`

不影响的方法：`deleteMessage`、`answerCallbackQuery`、`getUpdates`、`deleteWebhook`、`setMyCommands`、`getFile`、`downloadFile`。

## HTML 格式化

所有 Telegram 消息使用 HTML `parse_mode`（比 MarkdownV2 更容易转义）。

工具函数（`format.ts`）：

| 函数 | 输出 |
|------|------|
| `escapeHtml(text)` | 转义 `&`、`<`、`>` |
| `bold(text)` | `<b>text</b>` |
| `italic(text)` | `<i>text</i>` |
| `code(text)` | `<code>text</code>` |
| `pre(text, lang?)` | `<pre>text</pre>` 或 `<pre><code class="language-x">text</code></pre>` |
| `link(text, url)` | `<a href="url">text</a>` |
| `chunkText(text, max)` | 智能分块（优先在换行/空格处分割） |

## Callback 数据解析

`parseCallbackData(data)` 验证并解析 inline keyboard 回调：

- 最大 256 字符
- 以 `:` 分隔，第一段为 prefix
- 有效 prefix：`tmux`、`confirm`、`sess`、`term`、`model`、`think`、`agent`
- 返回 `{ prefix, parts }` 或 `null`（无效数据）

## Inline Keyboard 构建器

| 函数 | 用途 |
|------|------|
| `tmuxSessionsKeyboard` | tmux 会话列表（每行 2 个） |
| `tmuxSessionActionsKeyboard` | 单个 tmux 会话操作 |
| `tmuxTerminalKeyboard` | 终端模式按钮 |
| `tmuxResizeKeyboard` | 窗口大小预设 |
| `confirmKeyboard` | 确认/取消对话框 |
| `agentActionsKeyboard` | Agent 操作（Abort） |
| `modelsKeyboard` | 模型选择器 |
| `thinkingKeyboard` | Thinking level 选择器 |
| `agentSessionsKeyboard` | Agent 会话列表（分页） |
