/** Bridges the sandboxed renderer to its API base and main-process secret store. */
import { contextBridge, ipcRenderer } from "electron";

const prefix = "--pizza-api-base=";
const arg = process.argv.find((a) => a.startsWith(prefix));
const apiBase = arg ? arg.slice(prefix.length) : "";
const localLogs = process.argv.includes("--pizza-local-logs=1");
const localSecrets = process.argv.includes("--pizza-local-secrets=1");
const apiToken = ipcRenderer.sendSync("pizza:api-token") as string;

contextBridge.exposeInMainWorld("__PIZZA_API_BASE__", apiBase);
contextBridge.exposeInMainWorld("__PIZZA_API_TOKEN__", apiToken);

/**
 * Secret values flow only to main for encryption and child-env injection. The
 * renderer can retrieve names, never values.
 */
const secrets: PizzaSecretsBridge = {
  list: () => ipcRenderer.invoke("pizza:secrets:list") as Promise<string[]>,
  set: (name, value) => ipcRenderer.invoke("pizza:secrets:set", name, value) as Promise<void>,
  delete: (name) => ipcRenderer.invoke("pizza:secrets:delete", name) as Promise<void>,
};
if (localSecrets) contextBridge.exposeInMainWorld("__PIZZA_SECRETS__", secrets);

const connection: PizzaConnectionBridge = {
  get: () =>
    ipcRenderer.invoke("pizza:connection:get") as Promise<PizzaConnectionState>,
  useRemote: (input) =>
    ipcRenderer.invoke("pizza:connection:remote", input) as Promise<PizzaConnectionState>,
  useLocal: () =>
    ipcRenderer.invoke("pizza:connection:local") as Promise<PizzaConnectionState>,
};
contextBridge.exposeInMainWorld("__PIZZA_CONNECTION__", connection);

const logs: PizzaLogsBridge = {
  local: localLogs,
  write: (record) => ipcRenderer.send("pizza:logs:write", record),
  query: (query) => ipcRenderer.invoke("pizza:logs:query", query) as Promise<unknown>,
  clear: () =>
    ipcRenderer.invoke("pizza:logs:clear") as Promise<{ deleted: number }>,
};
contextBridge.exposeInMainWorld("__PIZZA_LOGS__", logs);

let openThreadListener: ((threadId: string) => void) | undefined;
let pendingOpenThreadId: string | undefined;
ipcRenderer.on(
  "pizza:notifications:open-thread",
  (_event: Electron.IpcRendererEvent, threadId: unknown) => {
    if (typeof threadId !== "string") return;
    if (openThreadListener) openThreadListener(threadId);
    else pendingOpenThreadId = threadId;
  },
);

const notifications: PizzaNotificationsBridge = {
  setActiveThread: (threadId) =>
    ipcRenderer.send("pizza:notifications:active-thread", threadId),
  getSettings: () =>
    ipcRenderer.invoke(
      "pizza:notifications:settings",
    ) as Promise<PizzaNotificationSettings>,
  updateSettings: (patch) =>
    ipcRenderer.invoke(
      "pizza:notifications:update-settings",
      patch,
    ) as Promise<PizzaNotificationSettings>,
  onOpenThread: (listener) => {
    openThreadListener = listener;
    if (pendingOpenThreadId !== undefined) {
      const threadId = pendingOpenThreadId;
      pendingOpenThreadId = undefined;
      listener(threadId);
    }
    return () => {
      if (openThreadListener === listener) openThreadListener = undefined;
    };
  },
};
contextBridge.exposeInMainWorld("__PIZZA_NOTIFICATIONS__", notifications);

interface PizzaSecretsBridge {
  list(): Promise<string[]>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

interface PizzaLogsBridge {
  local: boolean;
  write(record: unknown): void;
  query(query?: unknown): Promise<unknown>;
  clear(): Promise<{ deleted: number }>;
}

interface PizzaConnectionState {
  mode: "local" | "remote";
  remoteUrl?: string;
  hasToken: boolean;
  managedByEnvironment: boolean;
}

interface PizzaConnectionBridge {
  get(): Promise<PizzaConnectionState>;
  useRemote(input: {
    remoteUrl: string;
    token?: string | null;
  }): Promise<PizzaConnectionState>;
  useLocal(): Promise<PizzaConnectionState>;
}

interface PizzaNotificationsBridge {
  setActiveThread(threadId: string | null): void;
  getSettings(): Promise<PizzaNotificationSettings>;
  updateSettings(
    patch: Partial<PizzaNotificationSettings>,
  ): Promise<PizzaNotificationSettings>;
  onOpenThread(listener: (threadId: string) => void): () => void;
}

interface PizzaNotificationSettings {
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
}

declare global {
  interface Window {
    __PIZZA_API_BASE__?: string;
    __PIZZA_API_TOKEN__?: string;
    __PIZZA_SECRETS__?: PizzaSecretsBridge;
    __PIZZA_CONNECTION__?: PizzaConnectionBridge;
    __PIZZA_LOGS__?: PizzaLogsBridge;
    __PIZZA_NOTIFICATIONS__?: PizzaNotificationsBridge;
  }
}
