#!/bin/bash

# 1. 进入项目目录
cd "/Users/deepwind/repo/agent-stuff/services/telegram-agent"

# 2. 定义启动命令
COMMAND="/opt/homebrew/bin/bun run src/main-telegram.ts"

echo "--- 极简守护进程已启动 [PID: $$] ---"

# 3. 进入无限循环
while true; do
    echo "[$(date)] 服务启动中..."
    
    # 执行服务（这里会阻塞，直到程序退出）
    $COMMAND
    
    # 程序退出后才会执行到这里
    EXIT_CODE=$?
    echo "[$(date)] 服务已退出，退出码: $EXIT_CODE"

    # 如果是人为 Ctrl+C (退出码 130)，则彻底停止循环
    if [ $EXIT_CODE -eq 130 ]; then
        echo "检测到手动停止，守护进程退出。"
        break
    fi

    echo "服务崩溃或主动要求重启，2秒后自动拉起..."
    sleep 2
done
