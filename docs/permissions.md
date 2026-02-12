# Tool Permission System

工具权限系统（Tool Permissions）提供细粒度的 Agent 工具控制能力，遵循 Claude Code 的设计原则。

## 概述

权限系统允许你控制 Agent 可以使用的工具，通过规则定义哪些操作可以自动执行、哪些需要确认、哪些被禁止。

## 核心概念

### 权限级别（Permission Levels）

| 级别 | 说明 |
|------|------|
| `allow` | 自动批准匹配的工具使用 |
| `ask` | 提示用户确认（通过 Telegram 按钮） |
| `deny` | 阻止匹配的工具使用 |

**规则评估顺序**: `deny` → `ask` → `allow`（第一个匹配的规则生效）

### 权限模式（Permission Modes）

| 模式 | 说明 |
|------|------|
| `default` | 首次使用危险工具时提示确认（默认） |
| `acceptEdits` | 自动接受文件编辑，其他危险工具询问 |
| `dontAsk` | 除非通过规则预批准，否则自动拒绝 |
| `bypassPermissions` | 跳过所有权限检查（谨慎使用！） |

## 命令

### 查看当前权限

```
/permissions
```

显示当前权限模式、已配置的规则列表。

### 添加规则

```
/permissions allow <rule>   # 自动批准
/permissions ask <rule>     # 提示确认
/permissions deny <rule>    # 阻止
```

### 设置权限模式

```
/permissions mode <mode>
```

例如：`/permissions mode acceptEdits`

### 清除所有规则

```
/permissions clear
```

清除所有自定义规则，保留权限模式。

## 规则语法

规则格式：`Tool` 或 `Tool(specifier)`

### 基础规则

| 规则 | 效果 |
|------|------|
| `bash` | 匹配所有 bash 命令 |
| `read` | 匹配所有文件读取 |
| `write` | 匹配所有文件写入 |
| `edit` | 匹配所有文件编辑 |

### 带限定符的规则

使用括号指定更精确的匹配：

```
bash(npm run *)          # 匹配 npm run 开头的命令
read(./.env)             # 匹配读取 .env 文件
edit(./src/**/*.ts)      # 匹配编辑 src 目录下的 TypeScript 文件
write(./secrets/**)      # 匹配写入 secrets 目录
```

## 工具特定模式

### Bash 命令

支持 glob 模式匹配 `*`：

| 规则 | 匹配示例 |
|------|----------|
| `bash(npm run build)` | 精确匹配 `npm run build` |
| `bash(npm run *)` | `npm run dev`, `npm run test` 等 |
| `bash(git *)` | 所有 git 命令 |
| `bash(* install)` | 以 `install` 结尾的命令 |
| `bash(curl *)` | 所有 curl 命令 |

**重要**: 空格很重要。`bash(ls *)` 匹配 `ls -la` 但不匹配 `lsof`，而 `bash(ls*)` 两者都匹配。

### 文件路径（read/edit/write）

使用 gitignore 风格的模式匹配：

| 模式 | 含义 | 示例 |
|------|------|------|
| `//path` | 绝对路径 | `read(//Users/alice/secrets/**)` |
| `~/path` | 用户主目录 | `read(~/.ssh/*)` |
| `/path` | 相对于 Agent 工作目录 | `edit(/src/**/*.ts)` |
| `path` | 相对于当前目录 | `read(*.env)` |

通配符：
- `*` - 匹配单个目录内的文件
- `**` - 递归匹配跨目录

示例：
```
edit(./src/**/*.ts)      # 匹配 src 及其子目录下的 .ts 文件
read(./config/*.json)    # 匹配 config 目录下的 .json 文件
write(./.env)            # 匹配 .env 文件
deny(read(./secrets/**)) # 禁止读取 secrets 目录
```

### tmux 工具

```
tmux_send_keys(session-name)      # 匹配特定 session
tmux_kill_session(*)              # 匹配所有 kill 操作
tmux_new_session(my-session)      # 匹配特定 session 名称
```

## 配置示例

### 开发环境配置

允许常见的开发命令，但询问敏感的 git 操作：

```
/permissions allow bash(npm run *)
/permissions allow bash(npm install)
/permissions allow bash(git status)
/permissions allow bash(git diff *)
/permissions ask bash(git push *)
/permissions ask bash(git commit *)
```

### 保护敏感文件

```
/permissions deny read(./.env)
/permissions deny read(./.env.*)
/permissions deny read(./secrets/**)
/permissions deny write(./.env)
```

### 安全的文件编辑模式

自动接受代码编辑，但询问其他操作：

```
/permissions mode acceptEdits
```

### 完全自动模式（谨慎！）

```
/permissions mode bypassPermissions
```

## 安全建议

1. **从严格开始**: 初始使用 `default` 模式，逐步添加 `allow` 规则
2. **保护敏感文件**: 使用 `deny` 规则阻止访问 `.env`, `secrets/` 等
3. **限制网络工具**: 谨慎使用 `bash(curl *)` 或 `bash(wget *)` 的 allow 规则
4. **审查 bash 规则**: Bash 模式匹配是前缀匹配，复杂命令可能绕过简单规则

## 实现细节

- 权限配置按会话存储（每个 Telegram 聊天独立）
- 规则修改立即生效（对新的工具调用）
- 待处理的授权请求在会话结束时自动取消
- 授权请求有 5 分钟超时时间

## 与 Claude Code 的兼容性

本系统遵循 Claude Code 的权限设计，规则语法兼容：

- 相同的规则格式：`Tool` 或 `Tool(specifier)`
- 相同的评估顺序：`deny` → `ask` → `allow`
- 类似的模式匹配语义
- 相同的权限模式名称

差异：
- 本系统通过 Telegram 按钮进行授权确认
- 权限配置存储在内存中（非持久化文件）
