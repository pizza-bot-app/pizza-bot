/** Adds a fresh, transient clock reading to every model call. */
import { dynamicSystemPromptMiddleware } from "langchain";

export interface CurrentDateTimeMiddlewareOptions {
  now?: () => Date;
  timeZone?: string;
}

const MINUTE_MS = 60_000;

export function currentDateTimeContext(date: Date, timeZone: string): string {
  // Minute precision is sufficient for conversation while preserving prompt-cache
  // reuse across the model/tool loop when several calls happen close together.
  const instant = new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);

  return (
    `Current date and time: ${local} ` +
    `(${timeZone}; ${instant.toISOString()}). ` +
    "Treat this runtime-provided timestamp as authoritative for relative dates " +
    'such as "today" and do not infer the current date from training-data cutoffs.'
  );
}

export function currentDateTimeMiddleware(
  options: CurrentDateTimeMiddlewareOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return dynamicSystemPromptMiddleware(() =>
    currentDateTimeContext(now(), timeZone),
  );
}
