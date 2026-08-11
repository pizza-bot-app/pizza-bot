export const NATIVE_NOTIFICATION_CHANNELS = {
  activeThread: "pizza:notifications:active-thread",
  openThread: "pizza:notifications:open-thread",
  settings: "pizza:notifications:settings",
  updateSettings: "pizza:notifications:update-settings",
} as const;

interface NativeNotificationBase {
  threadId: string;
  threadTitle: string;
}

export type NativeNotificationRequest =
  | (NativeNotificationBase & {
      kind: "run-complete" | "action-required";
    })
  | (NativeNotificationBase & {
      kind: "run-failed";
      reason: "error" | "timeout";
    });

export interface NativeNotificationCopy {
  title: string;
  body: string;
}

export interface NativeNotificationPreferences {
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
}

export interface NativeNotificationContext {
  windowFocused: boolean;
  activeThreadId: string | null;
}

const MAX_TITLE_CODE_POINTS = 48;

export class BoundedRetention<T> {
  private readonly values = new Set<T>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("retention limit must be a positive integer");
    }
  }

  retain(value: T): () => void {
    this.values.add(value);
    while (this.values.size > this.limit) {
      const oldest = this.values.values().next().value as T | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return () => {
      this.values.delete(value);
    };
  }

  get size(): number {
    return this.values.size;
  }
}

export function nativeNotificationEnabled(
  request: NativeNotificationRequest,
  preferences: NativeNotificationPreferences,
  context: NativeNotificationContext,
): boolean {
  if (
    context.windowFocused &&
    context.activeThreadId === request.threadId
  ) {
    return false;
  }
  return request.kind === "action-required"
    ? preferences.notifyOnActionRequired
    : preferences.notifyOnRunCompletion;
}

export function nativeNotificationCopy(
  request: NativeNotificationRequest,
): NativeNotificationCopy {
  const normalizedTitle = request.threadTitle.trim().replace(/\s+/g, " ");
  const codePoints = Array.from(normalizedTitle || "Conversation");
  const shortened =
    codePoints.length > MAX_TITLE_CODE_POINTS
      ? `${codePoints.slice(0, MAX_TITLE_CODE_POINTS - 3).join("")}...`
      : codePoints.join("");
  switch (request.kind) {
    case "action-required":
      return {
        title: "Action required",
        body: `${shortened} is waiting for your input.`,
      };
    case "run-failed":
      return request.reason === "timeout"
        ? {
            title: "Run timed out",
            body: `${shortened} did not finish in time.`,
          }
        : {
            title: "Run failed",
            body: `${shortened} stopped before finishing.`,
          };
    case "run-complete":
      return {
        title: "Run finished",
        body: `${shortened} has finished.`,
      };
  }
}
