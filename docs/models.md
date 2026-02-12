# 模型配置

## 概述

支持多模型配置，通过 `models.json` 定义可用模型列表，运行时可通过 `/model` 命令或 inline keyboard 切换。

## 源文件

- `src/models.ts` — `ModelRegistry`、`ModelStore`、`loadModels()`
- `src/agent/session.ts` — 模型切换与降级逻辑
- `src/session/controller.ts` — `/model`、`/thinking` 命令与 callback 处理

## 配置文件

`models.json`（位于 `DATA_DIR` 下）：

```json
{
  "defaultModel": "sonnet4",
  "models": [
    {
      "key": "sonnet4",
      "label": "Claude Sonnet 4",
      "provider": "anthropic",
      "id": "claude-sonnet-4-20250514",
      "thinkingLevel": "medium"
    }
  ]
}
```

### 字段说明

| 字段 | 必须 | 说明 |
|------|------|------|
| `key` | ✅ | 唯一标识符（1-32 字符） |
| `label` | ✅ | 显示名称（用于 Telegram UI） |
| `provider` | ✅ | 提供商（`anthropic`、`openai`、`deepseek` 等） |
| `id` | ✅ | 模型 ID |
| `baseUrl` | ❌ | 自定义 API 端点 |
| `apiFormat` | ❌ | API 格式：`anthropic-messages` 或 `openai-completions`（非内置模型必须设置） |
| `apiKey` | ❌ | API 密钥，支持 `env:VAR_NAME` 格式从环境变量读取 |
| `contextWindow` | ❌ | 上下文窗口大小（默认 200000） |
| `maxTokens` | ❌ | 最大输出 token（默认 64000） |
| `thinkingLevel` | ❌ | 默认思考级别 |

### API Key 解析

`apiKey` 字段支持两种格式：
- 直接值：`"sk-xxx"` — 直接使用（不推荐，会暴露在文件中）
- 环境变量引用：`"env:ANTHROPIC_API_KEY"` — 从环境变量读取

API key 通过 `ModelStore.registerApiKeys()` 注入到 SDK 的 `AuthStorage` 中。同一 provider 的多个模型如果设置了不同的 key，会使用第一个找到的。

## 模型注册流程

```
loadModels(dataDir)
  → 读取并解析 models.json
  → 验证每个模型（validateModel）
  → 解析 apiKey（env: 前缀）
  → 创建 ModelRegistry

ModelStore.getSdkModel(key)
  → 检查缓存
  → 尝试 getModel() 获取内置模型定义
    → 内置模型：合并自定义配置（baseUrl、contextWindow 等）
    → 非内置模型：从配置构建完整 Model 对象（需要 apiFormat）
  → 缓存并返回
```

## Thinking Level

支持的级别：`off` | `minimal` | `low` | `medium` | `high` | `xhigh`

- 全局默认通过环境变量 `THINKING_LEVEL` 设置（默认 `medium`）
- 每个模型可在 `models.json` 中覆盖默认级别
- 运行时通过 `/thinking` 命令或 inline keyboard 切换
- 切换模型时，如果新模型有 `thinkingLevel` 设置，会自动应用

## 模型降级（Fallback）

当 agent 调用 LLM 时遇到可恢复错误，自动切换到默认模型：

### 触发条件

正则匹配错误信息：`/403|401|429|5\d\d|timeout|ECONNREFUSED|ENOTFOUND|fetch failed/i`

### 降级流程

```
prompt() 抛出错误
  → 检查是否可恢复错误
  → 当前模型不是默认模型？
    → 切换到默认模型
    → 同步切换 thinking level
    → 调用 onModelFallback 回调 → 通知用户
  → 当前已是默认模型 → 将错误传递到 onError 回调
```

## Telegram 交互

### /model 命令

- `/model` — 显示当前模型信息和 inline keyboard 选择器
- `/model <key>` — 直接切换到指定模型

### /thinking 命令

- `/thinking` — 显示当前级别和 inline keyboard 选择器
- `/thinking <level>` — 直接设置级别

两个命令在 agent 运行时都会拒绝操作，需先 `/abort`。

### Callback 数据格式

- `model:pick:<key>` — 选择模型
- `model:cancel` — 取消选择
- `think:pick:<level>` — 选择 thinking level
- `think:cancel` — 取消选择
