/** Electron main process and local sidecar lifecycle. */
import {
  app,
  BrowserWindow,
  Notification,
  powerMonitor,
  shell,
  ipcMain,
  safeStorage,
} from "electron";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { startSidecar, type Sidecar } from "./sidecar.js";
import { SecretStore } from "./secret-store.js";
import {
  ConnectionStore,
  normalizeRemoteUrl,
  type ConnectionMode,
} from "./connection-store.js";
import { probeRemoteConnection } from "./connection-probe.js";
import { findMcpNode } from "@pizza-bot/plugin-sdk/runtime-resolver";
import { PROTOCOL_VERSION } from "@pizza-bot/core";
import { isAllowedRendererNavigation } from "./navigation-policy.js";
import { handleSquirrelStartup, SQUIRREL_APP_ID } from "./squirrel-startup.js";
import { resolveWindowIconPath } from "./window-icon.js";
import {
  BoundedRetention,
  NATIVE_NOTIFICATION_CHANNELS,
  nativeNotificationCopy,
  nativeNotificationEnabled,
  type NativeNotificationRequest,
} from "./native-notifications.js";
import {
  DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
  NotificationSettingsStore,
  type DesktopNotificationSettings,
} from "./notification-settings-store.js";
import { ThreadActivityWatcher } from "./thread-activity-watcher.js";
import {
  configureLogging,
  deleteLogFiles,
  installConsoleCapture,
  installProcessErrorHandlers,
  queryLogFiles,
  type LogLevel,
  type LogQuery,
} from "@pizza-bot/logging";

// Both guards run before any logging or data-root setup: the installer must not
// boot a sidecar or seed a data root, and a rejected second instance must leave
// no trace behind.
if (handleSquirrelStartup()) {
  process.exit(0);
}
// A second instance must not spawn another sidecar.
if (!app.requestSingleInstanceLock()) {
  process.exit(0);
}
// Dev runs (`electron .`) share this process's win32 platform check but must not
// register the production AUMID against node_modules/electron/dist/electron.exe —
// Windows caches that pairing (Start Menu shortcut + jump-list store) keyed by the
// AUMID string, and the generic Electron name/icon then bleeds into the real
// packaged install on the same machine, surviving reinstalls.
if (process.platform === "win32" && app.isPackaged) {
  app.setAppUserModelId(SQUIRREL_APP_ID);
}

// The ESM bundle injects `require`; use a distinct name to avoid redeclaration.
const nodeRequire = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED_API_VERSION = String(PROTOCOL_VERSION);

/**
 * Prefer system Node for stdio MCP servers. Electron-as-Node is a fallback for
 * pure-JS servers when no system runtime is available.
 */
function resolveMcpNodePath(): string | undefined {
  const system = findMcpNode();
  if (system) return system;
  return process.execPath || undefined;
}

/** Select the packaged JS bundle or development TS server entry. */
function resolveServerEntry(): string {
  const override = process.env.PIZZA_SERVER_ENTRY;
  if (override) return override;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "dist-server", "index.js");
  }
  const pkgJson = nodeRequire.resolve("@pizza-bot/api-server/package.json");
  return path.join(path.dirname(pkgJson), "src", "index.ts");
}

const WEB_DEV_URL = process.env.PIZZA_WEB_URL ?? "http://localhost:5173";
const WEB_DIST = process.env.PIZZA_WEB_DIST;
const isDev = !app.isPackaged && !WEB_DIST;

function resolveDataRoot(): string {
  return process.env.PIZZA_DATA_ROOT ?? path.join(homedir(), ".pizza-bot-oss");
}

const shellLogger = configureLogging({
  processName: "desktop",
  component: "shell",
  dataRoot: resolveDataRoot(),
});
installConsoleCapture(shellLogger.child({ component: "console" }));
installProcessErrorHandlers(shellLogger.child({ component: "process" }));

let sidecar: Sidecar | undefined;
let mainWindow: BrowserWindow | undefined;
let activeNotificationThreadId: string | null = null;
let secretStore: SecretStore | undefined;
let connectionStore: ConnectionStore | undefined;
let notificationSettingsStore: NotificationSettingsStore | undefined;
let notificationWatcher: ThreadActivityWatcher | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let systemResumeTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let rendererApiToken: string | undefined;
let connectionChangeInFlight = false;
let sidecarRestartInFlight = false;
const activeNotifications = new BoundedRetention<Notification>(128);

interface ActiveConnection {
  mode: ConnectionMode;
  apiBase: string;
  apiToken?: string;
  managedByEnvironment: boolean;
}

let activeConnection: ActiveConnection | undefined;

// Secret values flow renderer-to-main only; list exposes names.
const SECRET_CHANNELS = {
  list: "pizza:secrets:list",
  set: "pizza:secrets:set",
  delete: "pizza:secrets:delete",
} as const;
const API_TOKEN_CHANNEL = "pizza:api-token";
const CONNECTION_CHANNELS = {
  get: "pizza:connection:get",
  remote: "pizza:connection:remote",
  local: "pizza:connection:local",
} as const;
const LOG_CHANNEL = "pizza:logs:write";
const LOG_QUERY_CHANNEL = "pizza:logs:query";
const LOG_CLEAR_CHANNEL = "pizza:logs:clear";

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
void main();

async function main(): Promise<void> {
  await app.whenReady();
  shellLogger.info("Desktop shell ready", {
    event: "desktop.ready",
    packaged: app.isPackaged,
    version: app.getVersion(),
  });
  ipcMain.on(API_TOKEN_CHANNEL, (event) => {
    event.returnValue = rendererApiToken ?? "";
  });
  ipcMain.on(LOG_CHANNEL, (_event, record: unknown) => {
    writeRendererLog(record);
  });
  ipcMain.handle(LOG_QUERY_CHANNEL, (_event, query: LogQuery | undefined) =>
    queryLogFiles(path.join(resolveDataRoot(), "logs"), query),
  );
  ipcMain.handle(LOG_CLEAR_CHANNEL, () => ({
    deleted: deleteLogFiles(path.join(resolveDataRoot(), "logs")),
  }));
  ipcMain.handle(
    NATIVE_NOTIFICATION_CHANNELS.settings,
    () =>
      notificationSettingsStore?.settings() ??
      DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
  );
  ipcMain.handle(
    NATIVE_NOTIFICATION_CHANNELS.updateSettings,
    (_event, input: unknown) =>
      updateNotificationSettings(input),
  );
  ipcMain.on(
    NATIVE_NOTIFICATION_CHANNELS.activeThread,
    (event, threadId: unknown) => {
      const win = mainWindow;
      if (!win || event.sender !== win.webContents) return;
      activeNotificationThreadId =
        typeof threadId === "string" && threadId.length > 0
          ? threadId
          : null;
    },
  );
  registerPowerLifecycle();

  const dataRoot = resolveDataRoot();
  secretStore = new SecretStore(safeStorage, path.join(dataRoot, "secrets.json"));
  connectionStore = new ConnectionStore(
    safeStorage,
    path.join(dataRoot, "desktop-connection.json"),
  );
  notificationSettingsStore = new NotificationSettingsStore(
    path.join(dataRoot, "desktop-notifications.json"),
  );
  notificationWatcher = new ThreadActivityWatcher({
    notify: (request) => {
      showNativeNotification(request);
    },
    onError: (error) => {
      shellLogger.warn("Thread activity notification stream disconnected", {
        event: "desktop.notification_stream_disconnected",
        detail: error instanceof Error ? error.message : String(error),
      });
    },
  });
  registerSecretIpc();
  registerConnectionIpc(dataRoot);

  const configured = initialConnection();
  if (configured.mode === "local") {
    try {
      const apiToken = localApiToken();
      sidecar = await bootSidecar(dataRoot, apiToken);
      const connection: ActiveConnection = {
        mode: "local",
        apiBase: sidecar.baseUrl,
        apiToken,
        managedByEnvironment: false,
      };
      setActiveConnection(connection);
      createWindow(connection);
    } catch (err) {
      console.error("[shell] failed to start sidecar:", err);
      app.quit();
      return;
    }
  } else {
    setActiveConnection(configured);
    console.log(
      `[shell] remote mode: using ${configured.apiBase} (no local sidecar${
        configured.managedByEnvironment ? ", managed by environment" : ""
      })`,
    );
    createWindow(configured);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && activeConnection) {
      createWindow(activeConnection);
    }
  });
}

function initialConnection(): ActiveConnection | { mode: "local" } {
  const environmentUrl = process.env.PIZZA_API_BASE?.trim();
  if (environmentUrl) {
    return {
      mode: "remote",
      apiBase: normalizeRemoteUrl(environmentUrl),
      ...(process.env.PIZZA_API_TOKEN?.trim()
        ? { apiToken: process.env.PIZZA_API_TOKEN.trim() }
        : {}),
      managedByEnvironment: true,
    };
  }
  const saved = connectionStore?.settings();
  if (saved?.mode === "remote" && saved.remoteUrl) {
    const token = connectionStore?.remoteToken();
    return {
      mode: "remote",
      apiBase: saved.remoteUrl,
      ...(token ? { apiToken: token } : {}),
      managedByEnvironment: false,
    };
  }
  return { mode: "local" };
}

function setActiveConnection(connection: ActiveConnection): void {
  activeConnection = connection;
  connectNotificationWatcher(connection);
}

function connectNotificationWatcher(connection: ActiveConnection): void {
  notificationWatcher?.setConnection({
    sourceId:
      connection.mode === "local"
        ? "local"
        : `remote:${connection.apiBase}`,
    apiBase: connection.apiBase,
    ...(connection.apiToken ? { apiToken: connection.apiToken } : {}),
  });
}

function registerPowerLifecycle(): void {
  powerMonitor.on("suspend", () => {
    if (systemResumeTimer) {
      clearTimeout(systemResumeTimer);
      systemResumeTimer = undefined;
    }
    shellLogger.info("System suspending", { event: "desktop.system_suspend" });
    void sidecar?.suspend().then((delivered) => {
      if (!delivered) {
        shellLogger.warn("Sidecar did not acknowledge system suspend", {
          event: "desktop.system_suspend_unacknowledged",
        });
      }
    });
  });
  powerMonitor.on("resume", () => {
    shellLogger.info("System resumed", { event: "desktop.system_resume" });
    if (activeConnection) connectNotificationWatcher(activeConnection);
    if (systemResumeTimer) clearTimeout(systemResumeTimer);
    systemResumeTimer = setTimeout(() => {
      systemResumeTimer = undefined;
      const current = sidecar;
      if (!current || activeConnection?.mode !== "local") return;
      void current.resume().then((recovered) => {
        const context = { event: "desktop.system_resume_recovery" };
        if (recovered) {
          shellLogger.info("Sidecar resumed scheduled and MCP services", context);
        } else {
          shellLogger.warn("Sidecar resume recovery did not complete", context);
        }
      });
    }, 2_000);
    systemResumeTimer.unref?.();
  });
}

/** Fork the sidecar with secrets decrypted from current storage. */
async function bootSidecar(dataRoot: string, apiToken: string): Promise<Sidecar> {
  const mcpNodePath = resolveMcpNodePath();
  return startSidecar({
    serverModulePath: resolveServerEntry(),
    dataRoot,
    apiToken,
    expectedApiVersion: EXPECTED_API_VERSION,
    ...(secretStore ? { extraEnv: secretStore.decryptAll() } : {}),
    ...(mcpNodePath ? { mcpNodePath } : {}),
    // In dev the renderer loads from the Vite origin and calls the sidecar
    // directly, so that origin must be on the child's CORS allowlist.
    ...(isDev ? { allowedOrigins: `null,${WEB_DEV_URL}` } : {}),
    // Packaged paths pin native ABI resolution and locate shipped contributions.
    ...(app.isPackaged
      ? {
          nativeModulesPath: path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
          pluginsDir: path.join(process.resourcesPath, "plugins"),
          builtinSkillsDir: path.join(process.resourcesPath, "skills"),
        }
      : {}),
    onFatal: (err) => {
      console.error("[shell] sidecar fatal:", err.message);
    },
    onReady: (hs) => {
      console.log(`[shell] sidecar ready on port ${hs.port} (pid ${hs.pid})`);
    },
    onEndpointChanged: (baseUrl) => {
      if (activeConnection?.mode !== "local") return;
      console.log(`[shell] sidecar endpoint changed to ${baseUrl}; reloading renderer`);
      const next: ActiveConnection = {
        mode: "local",
        apiBase: baseUrl,
        apiToken,
        managedByEnvironment: false,
      };
      setActiveConnection(next);
      replaceWindowForConnection(next);
    },
  });
}

function localApiToken(): string {
  return randomBytes(32).toString("base64url");
}

function replaceWindowForConnection(connection: ActiveConnection): void {
  if (shuttingDown) return;
  const previous = mainWindow;
  createWindow(connection);
  previous?.close();
}

/** Mutate encrypted secrets in main and restart the child to refresh its env. */
function registerSecretIpc(): void {
  ipcMain.handle(SECRET_CHANNELS.list, () => secretStore?.list() ?? []);
  ipcMain.handle(SECRET_CHANNELS.set, (_e, name: string, value: string) => {
    secretStore?.set(name, value);
    scheduleSidecarRestart();
  });
  ipcMain.handle(SECRET_CHANNELS.delete, (_e, name: string) => {
    secretStore?.delete(name);
    scheduleSidecarRestart();
  });
}

function registerConnectionIpc(dataRoot: string): void {
  ipcMain.handle(CONNECTION_CHANNELS.get, () => publicConnectionState());
  ipcMain.handle(
    CONNECTION_CHANNELS.remote,
    async (
      _event,
      input: { remoteUrl: string; token?: string | null },
    ) => {
      assertConnectionCanChange();
      connectionChangeInFlight = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      try {
        const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
        const savedToken = connectionStore?.remoteTokenFor(remoteUrl);
        const token =
          input.token === undefined
            ? savedToken
            : input.token === null
              ? undefined
              : input.token.trim() || undefined;
        const result = await probeRemoteConnection({
          remoteUrl,
          ...(token ? { token } : {}),
          origin: rendererOrigin(),
          expectedApiVersion: EXPECTED_API_VERSION,
        });
        connectionStore?.useRemote(result.remoteUrl, token);
        const next: ActiveConnection = {
          mode: "remote",
          apiBase: result.remoteUrl,
          ...(token ? { apiToken: token } : {}),
          managedByEnvironment: false,
        };
        setActiveConnection(next);
        setTimeout(() => {
          void activateRemoteConnection(next).finally(() => {
            connectionChangeInFlight = false;
          });
        }, 0);
        return publicConnectionState();
      } catch (err) {
        connectionChangeInFlight = false;
        throw err;
      }
    },
  );
  ipcMain.handle(CONNECTION_CHANNELS.local, async () => {
    assertConnectionCanChange();
    connectionChangeInFlight = true;
    try {
      if (activeConnection?.mode === "local" && sidecar) {
        connectionStore?.useLocal();
        connectionChangeInFlight = false;
        return publicConnectionState();
      }
      const apiToken = localApiToken();
      const nextSidecar = await bootSidecar(dataRoot, apiToken);
      try {
        connectionStore?.useLocal();
      } catch (err) {
        await nextSidecar.stop().catch(() => {});
        throw err;
      }
      sidecar = nextSidecar;
      const next: ActiveConnection = {
        mode: "local",
        apiBase: nextSidecar.baseUrl,
        apiToken,
        managedByEnvironment: false,
      };
      setActiveConnection(next);
      setTimeout(() => {
        if (activeConnection === next) replaceWindowForConnection(next);
        connectionChangeInFlight = false;
      }, 0);
      return publicConnectionState();
    } catch (err) {
      connectionChangeInFlight = false;
      throw err;
    }
  });
}

function assertConnectionCanChange(): void {
  if (activeConnection?.managedByEnvironment) {
    throw new Error(
      "Backend selection is managed by PIZZA_API_BASE. Remove it and restart the app to change connections here.",
    );
  }
  if (connectionChangeInFlight) {
    throw new Error("A backend connection change is already in progress.");
  }
  if (sidecarRestartInFlight) {
    throw new Error("The embedded backend is restarting. Try again in a moment.");
  }
}

function publicConnectionState(): {
  mode: ConnectionMode;
  remoteUrl?: string;
  hasToken: boolean;
  managedByEnvironment: boolean;
} {
  const saved = connectionStore?.settings();
  const managed = activeConnection?.managedByEnvironment ?? false;
  const remoteUrl =
    activeConnection?.mode === "remote"
      ? activeConnection.apiBase
      : saved?.remoteUrl;
  return {
    mode: activeConnection?.mode ?? "local",
    ...(remoteUrl ? { remoteUrl } : {}),
    hasToken:
      activeConnection?.mode === "remote"
        ? activeConnection.apiToken !== undefined
        : (saved?.hasToken ?? false),
    managedByEnvironment: managed,
  };
}

function rendererOrigin(): string {
  return isDev ? new URL(WEB_DEV_URL).origin : "null";
}

async function activateRemoteConnection(next: ActiveConnection): Promise<void> {
  if (shuttingDown || activeConnection !== next) return;
  replaceWindowForConnection(next);
  const oldSidecar = sidecar;
  sidecar = undefined;
  await oldSidecar
    ?.stop()
    .catch((err) => console.error("[shell] sidecar stop during remote switch failed:", err));
}

/** Coalesce secret changes because child env and the window API base are immutable. */
function scheduleSidecarRestart(): void {
  if (!sidecar) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void restartSidecar();
  }, 400);
  restartTimer.unref?.();
}

async function restartSidecar(): Promise<void> {
  if (
    activeConnection?.mode !== "local" ||
    sidecarRestartInFlight ||
    connectionChangeInFlight
  ) {
    return;
  }
  sidecarRestartInFlight = true;
  const dataRoot = resolveDataRoot();
  const old = sidecar;
  let nextSidecar: Sidecar | undefined;
  try {
    console.log("[shell] restarting sidecar to apply secret changes...");
    sidecar = undefined;
    await old?.stop();
    const apiToken = localApiToken();
    nextSidecar = await bootSidecar(dataRoot, apiToken);
    sidecar = nextSidecar;
    const next: ActiveConnection = {
      mode: "local",
      apiBase: nextSidecar.baseUrl,
      apiToken,
      managedByEnvironment: false,
    };
    setActiveConnection(next);
    replaceWindowForConnection(next);
  } catch (err) {
    console.error("[shell] sidecar restart failed:", err);
    await nextSidecar?.stop().catch(() => {});
    sidecar = undefined;
  } finally {
    sidecarRestartInFlight = false;
  }
}

function createWindow(connection: ActiveConnection): void {
  rendererApiToken = connection.apiToken;
  const rendererEntry = resolveRendererEntry();
  const windowIcon = resolveWindowIconPath({
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    title: "Pizza Bot OSS",
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      // Sandboxed Electron preloads load as CommonJS.
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--pizza-api-base=${connection.apiBase}`,
        `--pizza-local-logs=${connection.mode === "local" ? "1" : "0"}`,
        `--pizza-local-secrets=${connection.mode === "local" ? "1" : "0"}`,
      ],
    },
  });
  activeNotificationThreadId = null;
  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  const guardNavigation = (event: { preventDefault(): void }, url: string) => {
    if (isAllowedRendererNavigation(url, rendererEntry)) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.webContents.on("did-start-loading", () => {
    if (mainWindow === win) activeNotificationThreadId = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (mainWindow === win) activeNotificationThreadId = null;
    shellLogger.error("Renderer process exited", undefined, {
      event: "desktop.renderer_gone",
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    shellLogger.error("Renderer failed to load", undefined, {
      event: "desktop.renderer_load_failed",
      errorCode,
      errorDescription,
      url: validatedURL,
    });
  });
  void win.loadURL(rendererEntry);

  win.on("blur", () => {
    if (mainWindow === win) activeNotificationThreadId = null;
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      activeNotificationThreadId = null;
      mainWindow = undefined;
    }
  });
}

function showNativeNotification(request: NativeNotificationRequest): boolean {
  if (!Notification.isSupported()) return false;
  const settings =
    notificationSettingsStore?.settings() ??
    DEFAULT_DESKTOP_NOTIFICATION_SETTINGS;
  if (
    !nativeNotificationEnabled(request, settings, {
      windowFocused: mainWindow?.isFocused() ?? false,
      activeThreadId: activeNotificationThreadId,
    })
  ) {
    return false;
  }

  const notification = new Notification(nativeNotificationCopy(request));
  const release = activeNotifications.retain(notification);
  notification.once("close", release);
  notification.once("failed", (_event, error) => {
    shellLogger.error("Native notification failed", error, {
      event: "desktop.notification_failed",
      kind: request.kind,
    });
    release();
  });
  notification.once("click", () => {
    openThreadFromNotification(request.threadId);
    release();
  });
  notification.show();
  return true;
}

function updateNotificationSettings(input: unknown): DesktopNotificationSettings {
  if (!notificationSettingsStore || !input || typeof input !== "object") {
    return (
      notificationSettingsStore?.settings() ??
      DEFAULT_DESKTOP_NOTIFICATION_SETTINGS
    );
  }
  const value = input as Record<string, unknown>;
  return notificationSettingsStore.patch({
    ...(typeof value.notifyOnRunCompletion === "boolean"
      ? { notifyOnRunCompletion: value.notifyOnRunCompletion }
      : {}),
    ...(typeof value.notifyOnActionRequired === "boolean"
      ? { notifyOnActionRequired: value.notifyOnActionRequired }
      : {}),
  });
}

function openThreadFromNotification(threadId: string): void {
  if (!mainWindow && activeConnection) createWindow(activeConnection);
  const win = mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const send = () =>
    win.webContents.send(NATIVE_NOTIFICATION_CHANNELS.openThread, threadId);
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function resolveRendererEntry(): string {
  if (isDev) return WEB_DEV_URL;
  const rendererPath = WEB_DIST ?? path.join(process.resourcesPath, "dist", "index.html");
  return pathToFileURL(rendererPath).href;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("child-process-gone", (_event, details) => {
  shellLogger.error("Electron child process exited", undefined, {
    event: "desktop.child_process_gone",
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
  });
});

function writeRendererLog(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  const component = typeof record.component === "string" ? record.component : "renderer";
  const message = typeof record.message === "string" ? record.message : "Renderer event";
  const level = isLogLevel(record.level) ? record.level : "info";
  const context =
    record.context && typeof record.context === "object"
      ? (record.context as Record<string, unknown>)
      : undefined;
  const logger = shellLogger.child({ component });
  if (level === "error") logger.error(message, record.error, context);
  else logger[level](message, context);
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

// Delay process exit until the sidecar drains or reaches its kill deadline.
app.on("before-quit", (event) => {
  notificationWatcher?.stop();
  notificationWatcher = undefined;
  if (systemResumeTimer) {
    clearTimeout(systemResumeTimer);
    systemResumeTimer = undefined;
  }
  if (shuttingDown || !sidecar) return;
  shuttingDown = true;
  event.preventDefault();
  console.log("[shell] stopping sidecar...");
  void sidecar
    .stop()
    .catch((err) => console.error("[shell] sidecar stop error:", err))
    .finally(() => {
      sidecar = undefined;
      app.quit();
    });
});
