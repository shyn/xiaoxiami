# 认证系统

## 概述

基于 owner pairing 的单 owner 认证模型。第一个发送 `/start` 的用户成为 owner，owner 可以授权其他用户。

## 源文件

- `src/auth.ts` — `AuthStore` 类
- `src/index.ts` — `handleAuthCommand()` 认证命令处理

## 数据结构

```typescript
interface AuthData {
  ownerId: number | null;        // Owner 的 Telegram user ID
  ownerUsername: string | null;   // Owner 的 username
  allowedUserIds: number[];       // 所有授权用户 ID（包含 owner）
  pairedAt: string | null;        // 配对时间（ISO 8601）
}
```

持久化为 JSON 文件（默认 `auth.json`，可通过 `AUTH_FILE` 环境变量配置）。

## 配对流程

```
Bot 启动 → isPaired() = false
  → 用户发送 /start（必须在私聊中）
    → auth.pair(userId, username)
      → 设置 ownerId、allowedUserIds = [userId]
      → 保存到文件
```

### 预设 Owner

通过环境变量 `OWNER_ID` 可预设 owner，跳过手动配对：

```bash
OWNER_ID=123456789
```

`index.ts` 启动时检测：如果设置了 `OWNER_ID` 且未配对，自动调用 `auth.pair(presetOwnerId)`。

## 授权检查

```
isAuthorized(userId):
  1. isPaired() = false → 拒绝所有
  2. userId === ownerId → 通过
  3. allowedUserIds.includes(userId) → 通过
  4. 否则 → 拒绝
```

## 命令

| 命令 | 权限 | 说明 |
|------|------|------|
| `/start` | 任何人 | 未配对时配对为 owner；已配对时显示拒绝消息 |
| `/adduser <user_id>` | Owner | 添加授权用户 |
| `/removeuser <user_id>` | Owner | 移除授权用户（不能移除 owner） |
| `/users` | Owner | 列出所有授权用户 |

非 owner 尝试执行 owner 命令时，返回 "🔒 Owner-only command."。

## 热重载

`AuthStore` 使用 `node:fs.watch()` 监视认证文件所在目录。文件被外部修改时自动重新加载，无需重启 bot。

写入使用原子操作：先写 `.tmp` 文件再 `rename`，避免中间状态。

## 处理顺序

在 `index.ts` 的 `handleUpdate()` 中，认证命令在 controller 路由之前同步处理（不经过 queue）：

```
Update 到达
  → 提取 chatId, threadId, userId
  → 持久化 raw update（messageStore）
  → 如果是 callback_query → 检查 isAuthorized → controller
  → 如果是 message:
    → 解析命令
    → handleAuthCommand() — 处理 /start, /adduser, /removeuser, /users
      → 已处理 → return
    → isAuthorized() 检查
      → 未授权 → 拒绝
    → enqueueForController() — 路由到 ChatController
```
