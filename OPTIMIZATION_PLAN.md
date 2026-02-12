# Telegram Agent 优化计划

## 高优先级 — 可靠性

- [x] 1. **轮询循环阻塞修复**: 在 ChatController 中引入串行队列，避免 agent 处理阻塞 polling
- [x] 2. **Offset 持久化**: 将 Telegram update offset 写入磁盘，重启后恢复
- [x] 3. **Telegram API 重试/限速/超时**: client.ts 增加 429 重试、5xx 重试、AbortController 超时
- [x] 4. **AuthStore 原子写入 + watch 修复**: 使用 tmp+rename 原子写入，修复文件不存在时 watch 失败

## 中优先级 — 架构 & 安全

- [x] 5. **拆分 controller.ts**: 拆为 streaming.ts、tmux-handler.ts 子模块，controller.ts 瘦身为协调层
- [x] 6. **Controller 生命周期管理**: 增加不活跃 TTL 和 dispose 清理
- [x] 7. **Owner 配对安全加固**: 限制私聊配对 + 支持 OWNER_ID 环境变量
- [x] 8. **日志安全**: API 响应日志增加 DEBUG_TELEGRAM 开关，避免泄漏消息内容

## 低优先级 — 功能增强

- [x] 9. **图片消息支持**: 处理 msg.photo，下载并传递给 agent
- [x] 10. **ensureNoWebhook 修复**: 直接调用 deleteWebhook 而非 getUpdates 检测
- [x] 11. **callback_data 类型安全**: 增加严格前缀解析和验证 (callback-parser.ts)
- [x] 12. **TelegramMessageStore 数据轮转**: 增加日志轮转（按天分文件+自动清理）和禁用开关
