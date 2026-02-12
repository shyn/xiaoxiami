# Watchdog 守护进程需求文档 (PRD)

## 1. 目标 (Goal)
创建一个高可用的服务守护环境，使 Pi Agent 能够实现全自动的生命周期管理，包括自动重启、自我更新、故障检测及故障自动回滚。

## 2. 核心场景 (User Stories)
*   **服务常驻**：当服务因为偶发性错误（如 OOM、网络波动导致的未捕获异常）挂掉时，守护进程能立即将其拉起。
*   **指令重启**：用户通过 Telegram 发送更新或重启指令，机器人执行 `process.exit(0)`，守护进程识别并重新启动服务。
*   **全自动更新与回滚**：
    1.  机器人通过代码执行 `git pull` 更新代码。
    2.  机器人执行 `process.exit(0)` 触发重启。
    3.  守护进程启动新版代码并开始“稳定性监测”。
    4.  如果新版本在短时间内崩溃（判定为更新失败），守护进程自动将代码回滚至上一个稳定版本并重启。

## 3. 功能需求 (Functional Requirements)

### 3.1 进程守护 (Process Guarding)
*   通过无限循环监控主进程 (`src/main-telegram.ts`)。
*   主进程退出后，3-5 秒内必须自动重新启动。

### 3.2 稳定性监测 (Stability Monitoring)
*   设定 **稳定性门槛时间** (如 60 秒)。
*   如果进程运行时间超过该门槛，则标记当前 Git Commit 为“稳定版本” (`LAST_GOOD_COMMIT`)。

### 3.3 故障回滚 (Auto Rollback)
*   设定 **故障判定时间** (如 20 秒)。
*   如果进程在启动后极短时间内退出，且当前代码版本与 `LAST_GOOD_COMMIT` 不同，则：
    1.  记录错误日志。
    2.  执行 `git reset --hard $LAST_GOOD_COMMIT`。
    3.  重新执行环境初始化（如 `bun install`）。
    4.  启动回滚后的稳定版本。

### 3.4 错误记录 (Logging)
*   捕获标准错误输出 (stderr) 并持久化到 `logs/error.log`。
*   记录守护进程自身的动作（启动、检测、回滚）到 `logs/watchdog.log`。

## 4. 非功能需求 (Non-Functional Requirements)
*   **轻量化**：不依赖复杂的外部工具（如 Supervisor/PM2），仅通过原生的 Bash 脚本实现。
*   **透明性**：脚本逻辑清晰，便于维护和手动干预。
