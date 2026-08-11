import { inspect } from "node:util";
import { createRedactor, secretsFromEnv, type Redactor } from "./redact.js";
import { LogFileStore, type LogFileStoreOptions } from "./file-store.js";
import type { LogContext, LogLevel, LogRecord, Logger, LogValue } from "./types.js";
import { currentLogContext } from "./context.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export interface ConfigureLoggingOptions extends Omit<LogFileStoreOptions, "processName"> {
  processName: string;
  component?: string;
  level?: LogLevel;
  console?: boolean;
  knownSecrets?: readonly string[];
}

interface LoggerState {
  processName: string;
  level: LogLevel;
  console: boolean;
  redactor: Redactor;
  store: LogFileStore;
  counter: number;
}

let rootLogger: Logger | undefined;
let activeRedactor: Redactor | undefined;
let consoleInstalled = false;
let processHandlersInstalled = false;

export function configureLogging(options: ConfigureLoggingOptions): Logger {
  const redactor = createRedactor([
    ...secretsFromEnv(process.env),
    ...(options.knownSecrets ?? []),
  ]);
  activeRedactor = redactor;
  const maxFileBytes = options.maxFileBytes ?? megabytesFromEnv(process.env.PIZZA_LOG_MAX_FILE_MB);
  const maxTotalBytes = options.maxTotalBytes ?? megabytesFromEnv(process.env.PIZZA_LOG_MAX_TOTAL_MB);
  const retentionDays =
    options.retentionDays ?? positiveNumber(process.env.PIZZA_LOG_RETENTION_DAYS);
  const state: LoggerState = {
    processName: options.processName,
    level: options.level ?? levelFromEnv(process.env.PIZZA_LOG_LEVEL),
    console: options.console ?? process.env.NODE_ENV !== "test",
    redactor,
    store: new LogFileStore({
      ...options,
      ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
      ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
    }),
    counter: 0,
  };
  rootLogger = new StructuredLogger(state, {
    component: options.component ?? options.processName,
  });
  return rootLogger;
}

export function redactDiagnosticText(text: string): string {
  activeRedactor ??= createRedactor(secretsFromEnv(process.env));
  return activeRedactor.text(text);
}

export function getLogger(component?: string): Logger {
  if (!rootLogger) return new DeferredLogger(component);
  return component ? rootLogger.child({ component }) : rootLogger;
}

export function installConsoleCapture(logger: Logger = getLogger("console")): () => void {
  if (consoleInstalled) return () => {};
  consoleInstalled = true;
  console.debug = (...args: unknown[]) => logConsole(logger, "debug", args);
  console.info = (...args: unknown[]) => logConsole(logger, "info", args);
  console.log = (...args: unknown[]) => logConsole(logger, "info", args);
  console.warn = (...args: unknown[]) => logConsole(logger, "warn", args);
  console.error = (...args: unknown[]) => logConsole(logger, "error", args);
  return () => {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    consoleInstalled = false;
  };
}

export function installProcessErrorHandlers(logger: Logger = getLogger("process")): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logger.error("Uncaught exception", error, { event: "process.uncaught_exception", origin });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", reason, {
      event: "process.unhandled_rejection",
    });
  });
  process.on("warning", (warning) => {
    logger.warn("Process warning", { event: "process.warning", warning });
  });
}

class StructuredLogger implements Logger {
  constructor(
    private readonly state: LoggerState,
    private readonly bound: LogContext,
  ) {}

  child(context: LogContext & { component?: string }): Logger {
    return new StructuredLogger(this.state, { ...this.bound, ...context });
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    this.write("error", message, context, error);
  }

  event(level: LogLevel, event: string, message: string, context?: LogContext): void {
    this.write(level, message, { ...context, event });
  }

  private write(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.state.level]) return;
    const merged = { ...this.bound, ...currentLogContext(), ...context };
    const component =
      typeof merged.component === "string" ? merged.component : this.state.processName;
    const event = typeof merged.event === "string" ? merged.event : undefined;
    delete merged.component;
    delete merged.event;
    const sanitized = this.state.redactor.value(merged);
    const record: LogRecord = {
      id: `${this.state.processName}-${process.pid}-${Date.now().toString(36)}-${this.state.counter++}`,
      timestamp: new Date().toISOString(),
      level,
      process: this.state.processName,
      pid: process.pid,
      component,
      ...(event ? { event } : {}),
      message: this.state.redactor.text(message),
      ...(error !== undefined ? { error: this.state.redactor.error(error) } : {}),
      ...(isNonEmptyRecord(sanitized) ? { context: sanitized } : {}),
    };
    try {
      this.state.store.append(record);
    } catch (writeError) {
      originalConsole.error("[logging] failed to persist record:", writeError);
    }
    if (this.state.console) {
      const output = `[${record.timestamp}] [${level}] [${record.process}:${component}] ${record.message}`;
      const args = record.error ?? record.context;
      if (level === "error") originalConsole.error(output, args ?? "");
      else if (level === "warn") originalConsole.warn(output, args ?? "");
      else if (level === "debug") originalConsole.debug(output, args ?? "");
      else originalConsole.log(output, args ?? "");
    }
  }
}

class DeferredLogger implements Logger {
  constructor(
    private readonly component?: string,
    private readonly context: LogContext = {},
  ) {}

  child(context: LogContext & { component?: string }): Logger {
    return new DeferredLogger(context.component ?? this.component, { ...this.context, ...context });
  }

  debug(message: string, context?: LogContext): void {
    this.current().debug(message, { ...this.context, ...context });
  }

  info(message: string, context?: LogContext): void {
    this.current().info(message, { ...this.context, ...context });
  }

  warn(message: string, context?: LogContext): void {
    this.current().warn(message, { ...this.context, ...context });
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    this.current().error(message, error, { ...this.context, ...context });
  }

  event(level: LogLevel, event: string, message: string, context?: LogContext): void {
    this.current().event(level, event, message, { ...this.context, ...context });
  }

  private current(): Logger {
    if (!rootLogger) return NOOP_LOGGER;
    return this.component ? rootLogger.child({ component: this.component }) : rootLogger;
  }
}

function logConsole(logger: Logger, level: LogLevel, args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error);
  const message = args
    .filter((arg) => arg !== error)
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 5, breakLength: 160 })))
    .join(" ");
  if (level === "error") logger.error(message || "Console error", error);
  else logger[level](message);
}

function isNonEmptyRecord(value: LogValue): value is Record<string, LogValue> {
  return !Array.isArray(value) && typeof value === "object" && value !== null &&
    Object.keys(value).length > 0;
}

function levelFromEnv(value: string | undefined): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function megabytesFromEnv(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : parsed * 1024 * 1024;
}

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const NOOP_LOGGER: Logger = {
  child: () => NOOP_LOGGER,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
};
