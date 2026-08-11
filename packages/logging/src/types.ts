export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogValue =
  | string
  | number
  | boolean
  | null
  | LogValue[]
  | { [key: string]: LogValue };

export interface LogContext {
  [key: string]: unknown;
}

export interface LogError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: LogValue;
}

export interface LogRecord {
  id: string;
  timestamp: string;
  level: LogLevel;
  process: string;
  pid: number;
  component: string;
  event?: string;
  message: string;
  error?: LogError;
  context?: Record<string, LogValue>;
}

export interface LogQuery {
  levels?: readonly LogLevel[];
  processes?: readonly string[];
  components?: readonly string[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface LogQueryResult {
  records: LogRecord[];
  latestTimestamp?: string;
  truncated: boolean;
}

export interface Logger {
  child(context: LogContext & { component?: string }): Logger;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  event(level: LogLevel, event: string, message: string, context?: LogContext): void;
}
