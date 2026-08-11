import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
  NotificationSettingsStore,
} from "./notification-settings-store.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "notification-settings-"));
  file = path.join(dir, "desktop-notifications.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("NotificationSettingsStore", () => {
  it("defaults both notification kinds on", () => {
    expect(new NotificationSettingsStore(file).settings()).toEqual(
      DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
    );
  });

  it("persists each preference independently", () => {
    const store = new NotificationSettingsStore(file);
    expect(store.patch({ notifyOnRunCompletion: false })).toEqual({
      notifyOnRunCompletion: false,
      notifyOnActionRequired: true,
    });
    expect(new NotificationSettingsStore(file).settings()).toEqual({
      notifyOnRunCompletion: false,
      notifyOnActionRequired: true,
    });
  });

  it("falls back to defaults for an invalid file", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(file, '{"version":1,"notifyOnRunCompletion":"yes"}');

    expect(new NotificationSettingsStore(file).settings()).toEqual(
      DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
    );
  });
});
