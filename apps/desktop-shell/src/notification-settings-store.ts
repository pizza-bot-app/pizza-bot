import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface DesktopNotificationSettings {
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
}

interface StoredNotificationSettings extends DesktopNotificationSettings {
  version: 1;
}

export const DEFAULT_DESKTOP_NOTIFICATION_SETTINGS: DesktopNotificationSettings =
  {
    notifyOnRunCompletion: true,
    notifyOnActionRequired: true,
  };

export class NotificationSettingsStore {
  private stored: StoredNotificationSettings;

  constructor(private readonly filePath: string) {
    this.stored = load(filePath);
  }

  settings(): DesktopNotificationSettings {
    return {
      notifyOnRunCompletion: this.stored.notifyOnRunCompletion,
      notifyOnActionRequired: this.stored.notifyOnActionRequired,
    };
  }

  patch(
    patch: Partial<DesktopNotificationSettings>,
  ): DesktopNotificationSettings {
    this.stored = {
      ...this.stored,
      ...(typeof patch.notifyOnRunCompletion === "boolean"
        ? { notifyOnRunCompletion: patch.notifyOnRunCompletion }
        : {}),
      ...(typeof patch.notifyOnActionRequired === "boolean"
        ? { notifyOnActionRequired: patch.notifyOnActionRequired }
        : {}),
    };
    this.persist();
    return this.settings();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function load(filePath: string): StoredNotificationSettings {
  if (!existsSync(filePath)) {
    return { version: 1, ...DEFAULT_DESKTOP_NOTIFICATION_SETTINGS };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as Partial<StoredNotificationSettings>;
    if (
      parsed.version === 1 &&
      typeof parsed.notifyOnRunCompletion === "boolean" &&
      typeof parsed.notifyOnActionRequired === "boolean"
    ) {
      return {
        version: 1,
        notifyOnRunCompletion: parsed.notifyOnRunCompletion,
        notifyOnActionRequired: parsed.notifyOnActionRequired,
      };
    }
  } catch (error) {
    console.warn(
      `[notifications] could not read ${filePath}; using defaults. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  return { version: 1, ...DEFAULT_DESKTOP_NOTIFICATION_SETTINGS };
}
