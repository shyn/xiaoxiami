#!/bin/bash

# ==============================================================================
# Pi Agent Watchdog - 自动重启与故障回滚守护脚本
# ==============================================================================

# 配置区
COMMAND="/opt/homebrew/bin/bun run src/main-telegram.ts"
STABILITY_THRESHOLD=60      # 运行超过此秒数视为版本稳定
CRASH_THRESHOLD=20          # 运行少于此秒数视为启动失败
LOG_DIR="./logs"
ERROR_LOG="$LOG_DIR/error.log"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"

mkdir -p "$LOG_DIR"

# 初始化状态
LAST_GOOD_COMMIT=$(git rev-parse HEAD)
echo "[$(date)] 守护进程启动。初始稳定版本: ${LAST_GOOD_COMMIT:0:7}" | tee -a "$WATCHDOG_LOG"

while true; do
    START_TIME=$(date +%s)
    CURRENT_COMMIT=$(git rev-parse HEAD)
    
    echo "[$(date)] 启动服务 (Commit: ${CURRENT_COMMIT:0:7})..." | tee -a "$WATCHDOG_LOG"
    
    # 执行服务，记录错误日志
    # 使用 stdbuf 确保输出不被缓冲，方便 tail -f 观察
    $COMMAND 2>> "$ERROR_LOG"
    EXIT_CODE=$?
    
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    
    echo "[$(date)] 服务退出，代码: $EXIT_CODE，运行耗时: ${DURATION}s" | tee -a "$WATCHDOG_LOG"

    # --- 稳定性与回滚逻辑 ---

    # 情况 A: 服务运行足够久，判定为稳定版本
    if [ $DURATION -gt $STABILITY_THRESHOLD ]; then
        if [ "$LAST_GOOD_COMMIT" != "$CURRENT_COMMIT" ]; then
            echo "[$(date)] 新版本已稳定运行，更新稳定点至: ${CURRENT_COMMIT:0:7}" | tee -a "$WATCHDOG_LOG"
            LAST_GOOD_COMMIT=$CURRENT_COMMIT
        fi
    fi

    # 情况 B: 服务启动即崩溃，且当前是新代码，尝试回滚
    if [ $DURATION -lt $CRASH_THRESHOLD ] && [ "$CURRENT_COMMIT" != "$LAST_GOOD_COMMIT" ]; then
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" | tee -a "$WATCHDOG_LOG"
        echo "[$(date)] 警告: 启动即崩溃！正在执行回滚..." | tee -a "$WATCHDOG_LOG"
        echo "[$(date)] 目标稳定版本: ${LAST_GOOD_COMMIT:0:7}" | tee -a "$WATCHDOG_LOG"
        
        git reset --hard "$LAST_GOOD_COMMIT"
        /opt/homebrew/bin/bun install # 回滚依赖
        
        echo "[$(date)] 回滚完成，准备重启稳定版..." | tee -a "$WATCHDOG_LOG"
        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" | tee -a "$WATCHDOG_LOG"
        sleep 5
        continue
    fi

    # 情况 C: 手动终止（Ctrl+C 或退出码 130）
    if [ $EXIT_CODE -eq 130 ]; then
        echo "[$(date)] 收到手动停止信号，守护进程退出。" | tee -a "$WATCHDOG_LOG"
        break
    fi

    # 情况 D: 普通重启（由于代码 exit 或偶发崩溃）
    echo "[$(date)] 3秒后自动拉起服务..." | tee -a "$WATCHDOG_LOG"
    sleep 3
done
