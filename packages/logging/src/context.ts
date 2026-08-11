import { AsyncLocalStorage } from "node:async_hooks";
import type { LogContext } from "./types.js";

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
