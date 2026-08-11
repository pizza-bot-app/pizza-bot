import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSquirrelStartup, SQUIRREL_APP_ID } from "./squirrel-startup.js";

const EXE = "C:\\Users\\dev\\AppData\\Local\\pizza_bot_oss\\app-1.0.0\\pizza-bot-oss.exe";
const UPDATE_EXE = "C:\\Users\\dev\\AppData\\Local\\pizza_bot_oss\\Update.exe";

describe("squirrel startup", () => {
  it("creates shortcuts on install and repoints them on update", () => {
    for (const flag of ["--squirrel-install", "--squirrel-updated"]) {
      expect(resolveSquirrelStartup("win32", [EXE, flag, "1.0.0"], EXE)).toEqual({
        kind: "shortcut",
        exe: UPDATE_EXE,
        args: ["--createShortcut=pizza-bot-oss.exe"],
      });
    }
  });

  it("removes shortcuts on uninstall", () => {
    expect(resolveSquirrelStartup("win32", [EXE, "--squirrel-uninstall", "1.0.0"], EXE)).toEqual({
      kind: "shortcut",
      exe: UPDATE_EXE,
      args: ["--removeShortcut=pizza-bot-oss.exe"],
    });
  });

  it("quits without touching shortcuts when superseded", () => {
    expect(resolveSquirrelStartup("win32", [EXE, "--squirrel-obsolete", "1.0.0"], EXE)).toEqual({
      kind: "quit",
    });
  });

  it("runs normally on first launch after install", () => {
    expect(resolveSquirrelStartup("win32", [EXE, "--squirrel-firstrun"], EXE)).toEqual({
      kind: "run",
    });
  });

  it("runs normally with no arguments and ignores non-Squirrel flags", () => {
    expect(resolveSquirrelStartup("win32", [EXE], EXE)).toEqual({ kind: "run" });
    expect(resolveSquirrelStartup("win32", [EXE, "--inspect", "pizzabot://x"], EXE)).toEqual({
      kind: "run",
    });
  });

  it("never intercepts startup off Windows", () => {
    expect(resolveSquirrelStartup("darwin", ["/app/Pizza", "--squirrel-install"], "/app/Pizza")).toEqual(
      { kind: "run" },
    );
    expect(resolveSquirrelStartup("linux", ["/app/Pizza", "--squirrel-uninstall"], "/app/Pizza")).toEqual(
      { kind: "run" },
    );
  });

  it("does not mistake the executable path for a lifecycle flag", () => {
    const spoofed = "C:\\tmp\\--squirrel-install\\pizza-bot-oss.exe";
    expect(resolveSquirrelStartup("win32", [spoofed], spoofed)).toEqual({ kind: "run" });
  });

  // Squirrel builds the shortcut's AppUserModelID from the maker `name` and
  // `executableName`; a mismatch splits the taskbar button and breaks pinning,
  // and nothing else fails when the two drift apart.
  it("keeps the app user model id in sync with forge.config.ts", () => {
    const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const forgeConfig = readFileSync(path.join(shellRoot, "forge.config.ts"), "utf8");
    const packageId = /new MakerSquirrel\(\{[^}]*?name:\s*"([^"]+)"/s.exec(forgeConfig)?.[1];
    const executableName = /executableName:\s*"([^"]+)"/.exec(forgeConfig)?.[1];

    expect(packageId).toBeDefined();
    expect(executableName).toBeDefined();
    expect(SQUIRREL_APP_ID).toBe(`com.squirrel.${packageId}.${executableName}`);
  });
});
