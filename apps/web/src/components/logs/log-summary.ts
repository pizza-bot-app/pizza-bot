import type { LogRecord } from "@/api-client";

export function formatLogContextSummary(
  record: Pick<LogRecord, "message" | "context">,
): string | undefined {
  const context = record.context;
  if (!context) return undefined;

  const parts: Array<string | number> = [];
  const method = stringValue(context.method);
  const path = stringValue(context.path);
  const status = scalarValue(context.status);
  const mcpServer = stringValue(context.mcpServer);
  const mcpTool = stringValue(context.mcpTool);
  const inputType = stringValue(context.inputType);
  const processType = stringValue(context.type);
  const reason = stringValue(context.reason);
  const attempt = numberValue(context.attempt);
  const toolCount = numberValue(context.toolCount);
  const messageCount = numberValue(context.messageCount);
  const durationMs = numberValue(context.durationMs);
  const exitCode = numberValue(context.exitCode);
  const errorCode = numberValue(context.errorCode);

  add(parts, method && path ? `${method} ${path}` : method ?? path);
  addUnlessRepeated(parts, mcpServer, record.message);
  addUnlessRepeated(parts, mcpTool, record.message);
  addUnlessRepeated(parts, status, record.message);
  addUnlessRepeated(parts, inputType, record.message);
  add(parts, attempt === undefined ? undefined : `attempt ${attempt}`);
  add(parts, formatCount(toolCount, "tool"));
  add(parts, formatCount(messageCount, "message"));
  add(parts, durationMs === undefined ? undefined : `${durationMs} ms`);
  addUnlessRepeated(parts, processType, record.message);
  addUnlessRepeated(parts, reason, record.message);
  add(parts, exitCode === undefined ? undefined : `exit ${exitCode}`);
  add(parts, errorCode === undefined ? undefined : `error ${errorCode}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scalarValue(value: unknown): string | number | undefined {
  return stringValue(value) ?? numberValue(value);
}

function formatCount(value: number | undefined, singular: string): string | undefined {
  return value === undefined ? undefined : `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function add(parts: Array<string | number>, value: string | number | undefined): void {
  if (value !== undefined) parts.push(value);
}

function addUnlessRepeated(
  parts: Array<string | number>,
  value: string | number | undefined,
  message: string,
): void {
  if (value !== undefined && !containsValue(message, value)) parts.push(value);
}

function containsValue(message: string, value: string | number): boolean {
  const normalizedMessage = normalize(message);
  const normalizedValue = normalize(String(value));
  return normalizedValue.length > 0 && ` ${normalizedMessage} `.includes(` ${normalizedValue} `);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
