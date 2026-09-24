import type { McpServerEntryWire } from "@/api-client";

export type ParsedMcpJson = {
  name: string;
  entry: McpServerEntryWire;
  warnings: string[];
};

const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd", "enabled"]);
const URL_KEYS = new Set(["type", "url", "headers", "enabled"]);

export type McpJsonResult =
  | { ok: true; value: ParsedMcpJson }
  | { ok: false; error: string };

export function parseMcpJson(input: string): McpJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "Paste valid JSON to continue." };
  }

  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { ok: false, error: "JSON must contain an mcpServers object." };
  }

  const [name, ...skippedServers] = Object.keys(parsed.mcpServers);
  const config = name ? parsed.mcpServers[name] : undefined;
  if (!name || !isRecord(config)) {
    return { ok: false, error: "mcpServers must contain a server configuration." };
  }

  const command = config.command;
  const url = config.url;
  if (command !== undefined && url !== undefined) {
    return { ok: false, error: "A server cannot define both command and url." };
  }
  if (command === undefined && url === undefined) {
    return { ok: false, error: "A server must define command or url." };
  }
  if (command !== undefined && typeof command !== "string") {
    return { ok: false, error: "command must be a string." };
  }

  const type = config.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http" && type !== "sse") {
    return { ok: false, error: "Unknown MCP transport type." };
  }
  const typeWantsStdio = type === "stdio";
  const typeWantsUrl = type !== undefined && type !== "stdio";
  if ((typeWantsStdio && command === undefined) || (typeWantsUrl && url === undefined)) {
    return { ok: false, error: "The transport type does not match the server fields." };
  }

  const enabled = config.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false." };
  }

  if (typeof command === "string") {
    if (!command.trim()) {
      return { ok: false, error: "command must not be empty." };
    }
    if (!isOptionalStringArray(config.args) || !isStringRecord(config.env)) {
      return { ok: false, error: "args must be strings and env values must be strings." };
    }
    return {
      ok: true,
      value: {
        name,
        entry: {
          command,
          ...(config.args ? { args: config.args } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
          ...(enabled === undefined ? {} : { enabled }),
        },
        warnings: collectWarnings(config, STDIO_KEYS, skippedServers),
      },
    };
  }

  if (typeof url !== "string" || !isStringRecord(config.headers)) {
    return { ok: false, error: "url must be a string and header values must be strings." };
  }
  if (!URL.canParse(url)) {
    return { ok: false, error: "url must be a valid URL." };
  }
  return {
    ok: true,
    value: {
      name,
      entry: {
        ...(type === "sse" ? { type: "sse" as const } : {}),
        url,
        ...(config.headers ? { headers: config.headers } : {}),
        ...(enabled === undefined ? {} : { enabled }),
      },
      warnings: collectWarnings(config, URL_KEYS, skippedServers),
    },
  };
}

function collectWarnings(config: Record<string, unknown>, known: Set<string>, skippedServers: string[]): string[] {
  const unknown = Object.keys(config).filter((key) => !known.has(key));
  return [
    ...(skippedServers.length > 0 ? [`Only the first server was used; skipped: ${skippedServers.join(", ")}`] : []),
    ...(unknown.length > 0 ? [`Ignored unsupported fields: ${unknown.join(", ")}`] : []),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === "string"));
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}
