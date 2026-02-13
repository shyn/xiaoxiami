import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const logLevel = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

const transport = isDev
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss.l", // 毫秒级时间戳
        ignore: "pid,hostname",
        messageFormat: "{component} | {msg}",
      },
    }
  : undefined;

export const rootLogger = pino({
  level: logLevel,
  base: {
    pid: process.pid,
    hostname: require("node:os").hostname(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(transport ? { transport } : {}),
});

export type Logger = pino.Logger;

export interface LogContext {
  conversationId?: string;
  userId?: string | number;
  platform?: "telegram" | "wxwork";
  sessionId?: string;
  component?: string;
}

export function createLogger(context: LogContext): Logger {
  return rootLogger.child(context);
}

export default rootLogger;
