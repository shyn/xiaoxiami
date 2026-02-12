# 流式输出

## 概述

Agent 的响应通过流式输出逐步展示在 Telegram 中。`StreamingManager` 负责文本累积、节流编辑、消息分块和 draft 模式。

## 源文件

- `src/session/controller/streaming.ts` — `StreamingManager` 类
- `src/telegram/format.ts` — `chunkText()` 分块算法

## 输出模式

### Draft 模式（优先）

使用 Telegram 的 Draft Message API（`sendMessageDraft`），实现低延迟的流式显示：

- agent 开始时生成随机 `draftId`
- 文本累积后通过 `sendMessageDraft()` 更新 draft
- draft 最大显示 4000 字符，超过时截取末尾并添加 `…` 前缀
- 最终化时通过 `sendMessage()` 发送最终文本

### Edit 模式（回退）

Draft 失败时回退到传统的消息编辑模式：

- 首次发送新消息，记录 `currentMsgId`
- 后续更新通过 `editMessageText()` 编辑该消息
- 编辑失败时尝试发送新消息

## 节流机制

通过 `editThrottleMs`（默认 400ms）控制编辑频率：

```
handleTextDelta(delta)
  → 累积到 streamBuffer
  → scheduleEdit()
    → 如果已有 timer → 跳过
    → 设置 setTimeout(editThrottleMs)
      → flushStream()
```

## 消息分块

当文本超过 `telegramMaxChars`（默认 3800，低于 Telegram 4096 限制留余量）时自动分块：

```
chunkText(text, maxLen):
  1. 尝试在 maxLen 位置前找最近的换行符分割
  2. 换行符太靠前（< 30%）→ 尝试空格分割
  3. 空格也太靠前 → 强制在 maxLen 处截断
```

分块后的处理：
- **Draft 模式最终化**：每个 chunk 作为独立消息发送
- **Edit 模式**：编辑当前消息为第一块，剩余块作为新消息发送

## 状态管理

| 字段 | 说明 |
|------|------|
| `streamBuffer` | 当前累积的完整文本 |
| `currentMsgId` | Edit 模式下当前消息 ID |
| `editTimer` | 节流 timer 引用 |
| `draftId` | Draft 模式的 draft ID（0 = 已回退到 Edit 模式） |

## 生命周期

```
agent_start → startNewStream()
  → 重置 buffer 和 msgId
  → 生成新 draftId

text_delta → handleTextDelta()
  → 累积 + 节流编辑

agent_end → finalizeStream(errorMessage?)
  → 清除 timer
  → 如果有 errorMessage 且 buffer 为空 → 发送错误消息
  → 如果 buffer 有内容：
    → Draft 模式 → sendMessage() 发送最终文本
    → Edit 模式 → flushStreamEdit() 最后一次编辑
  → 重置所有状态
```

## 工具通知

`sendToolNotification(html)` 在流式输出期间发送工具执行通知消息（如 "💻 Running: ls -la"），与流式文本独立，不影响 buffer。
