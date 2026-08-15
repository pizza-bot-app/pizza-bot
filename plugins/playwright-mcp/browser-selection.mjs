import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const LINUX_BROWSER_PATHS = [
  "/opt/google/chrome/chrome",
  "/opt/google/chrome/google-chrome",
  "/opt/microsoft/msedge/msedge",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/microsoft-edge",
];

const BROWSER_SELECTION_FLAGS = [
  "--browser",
  "--executable-path",
  "--cdp-endpoint",
  "--extension",
  "--config",
];

export function hasBrowserSelection(args) {
  return args.some((arg) =>
    BROWSER_SELECTION_FLAGS.some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    ),
  );
}

export function installedBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  managedExecutablePath,
} = {}) {
  const configuredPath = env.PIZZA_PLAYWRIGHT_BROWSER_PATH?.trim();
  if (configuredPath) {
    return exists(configuredPath) ? { executablePath: configuredPath } : undefined;
  }
  if (platform === "darwin") {
    if (exists("/Applications/Google Chrome.app")) {
      return { channel: "chrome" };
    }
    if (exists("/Applications/Microsoft Edge.app")) {
      return { channel: "msedge" };
    }
    const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    if (exists(chromium)) return { executablePath: chromium };
  }
  if (platform === "win32") {
    const roots = [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
    ].filter(Boolean);
    for (const root of roots) {
      if (exists(join(root, "Google", "Chrome", "Application", "chrome.exe"))) {
        return { channel: "chrome" };
      }
    }
    for (const root of roots) {
      if (exists(join(root, "Microsoft", "Edge", "Application", "msedge.exe"))) {
        return { channel: "msedge" };
      }
    }
  }
  if (platform === "linux") {
    const executablePath = findOnPath(
      [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
      ],
      env.PATH,
      exists,
    );
    if (executablePath) return { executablePath };
    const conventionalPath = LINUX_BROWSER_PATHS.find((candidate) =>
      exists(candidate),
    );
    if (conventionalPath) return { executablePath: conventionalPath };
  }
  if (managedExecutablePath && exists(managedExecutablePath)) {
    return { executablePath: managedExecutablePath };
  }
  return undefined;
}

export function needsHeadlessMode({
  platform = process.platform,
  env = process.env,
} = {}) {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function findOnPath(names, pathValue, exists) {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}
