type BrowserLogLevel = "debug" | "info" | "warn" | "error";

interface BrowserLogRecord {
  level: BrowserLogLevel;
  component: string;
  message: string;
  error?: unknown;
  context?: Record<string, unknown>;
}

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api.?key|credential/i;
const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export function installBrowserLogging(
  apiBase: string,
  headers: Record<string, string>,
): () => void {
  const queue: BrowserLogRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (queue.length === 0) return;
    const records = queue.splice(0, queue.length);
    if (window.__PIZZA_LOGS__) {
      for (const record of records) window.__PIZZA_LOGS__.write(record);
      return;
    }
    void fetch(`${apiBase}/logs/client`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ records }),
      keepalive: true,
    }).catch(() => {
      // Delivery failures cannot be logged through the transport that just failed.
    });
  };

  const enqueue = (record: BrowserLogRecord) => {
    if (queue.length >= 100) queue.shift();
    queue.push(record);
    timer ??= setTimeout(flush, 200);
  };

  const fromConsole = (level: BrowserLogLevel, args: unknown[]) => {
    const error = args.find((arg) => arg instanceof Error);
    const message = args
      .filter((arg) => arg !== error)
      .map(formatValue)
      .join(" ");
    enqueue({
      level,
      component: "console",
      message: message || `Renderer ${level}`,
      ...(error ? { error: serialize(error) } : {}),
    });
  };

  console.debug = (...args) => {
    originalConsole.debug(...args);
    fromConsole("debug", args);
  };
  console.info = (...args) => {
    originalConsole.info(...args);
    fromConsole("info", args);
  };
  console.log = (...args) => {
    originalConsole.log(...args);
    fromConsole("info", args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    fromConsole("warn", args);
  };
  console.error = (...args) => {
    originalConsole.error(...args);
    fromConsole("error", args);
  };

  const onError = (event: ErrorEvent) => {
    enqueue({
      level: "error",
      component: "window",
      message: event.message || "Uncaught renderer error",
      error: serialize(event.error),
      context: { filename: event.filename, line: event.lineno, column: event.colno },
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    enqueue({
      level: "error",
      component: "window",
      message: "Unhandled renderer promise rejection",
      error: serialize(event.reason),
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    if (timer) clearTimeout(timer);
    flush();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    Object.assign(console, originalConsole);
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return redactText(value);
  try {
    return JSON.stringify(serialize(value));
  } catch {
    return String(value);
  }
}

function serialize(value: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "<redacted>";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
    };
  }
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "<max-depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => serialize(item, undefined, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).slice(0, 50).map(([childKey, child]) => [
      childKey,
      serialize(child, childKey, depth + 1, seen),
    ]),
  );
}

function redactText(value: string): string {
  return value
    .slice(0, 32_000)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&#\s]+/gi, "$1<redacted>");
}
