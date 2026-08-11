import { getLogger, redactDiagnosticText } from "@pizza-bot/logging";

interface StderrStreamLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
}

interface McpConnectionLike {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  readonly transport?: { readonly stderr?: StderrStreamLike | null } | undefined;
}

export interface McpClientLike {
  getClient(serverName: string): Promise<McpConnectionLike | undefined>;
}

export interface McpServerHealth {
  status: "connected" | "crashed";
  toolCount: number;
  crashedAt?: string;
  detail?: string;
  stderrTail?: string[];
}

const STDERR_TAIL_LINES = 50;

// The MCP adapter retains tools after an unexpected process close unless restart
// is enabled. This monitor reports the crash so the host can invalidate them.
export class McpHealthMonitor {
  readonly #log = getLogger("mcp");
  readonly #health = new Map<string, McpServerHealth>();
  readonly #stderrTails = new Map<string, string[]>();
  readonly #lastError = new Map<string, string>();
  #generation = 0;

  async arm(
    client: McpClientLike,
    catalog: Record<string, readonly string[]>,
    onCrash: (server: string) => void,
  ): Promise<void> {
    // Generation checks ignore late events from reload and shutdown teardown.
    const generation = ++this.#generation;
    this.#health.clear();
    this.#stderrTails.clear();
    this.#lastError.clear();

    for (const [server, toolNames] of Object.entries(catalog)) {
      this.#health.set(server, { status: "connected", toolCount: toolNames.length });
      const conn = await client.getClient(server).catch(() => undefined);
      if (!conn || generation !== this.#generation) continue;

      const stderr = conn.transport?.stderr;
      if (stderr) {
        const tail: string[] = [];
        this.#stderrTails.set(server, tail);
        stderr.on("data", (chunk) => {
          const text = chunk.toString();
          for (const line of text.split(/\r?\n/)) {
            if (line.length === 0) continue;
            const sanitizedLine = redactDiagnosticText(line);
            this.#log.info(sanitizedLine, {
              event: "mcp.stderr",
              mcpServer: server,
              stream: "stderr",
            });
            tail.push(sanitizedLine);
            if (tail.length > STDERR_TAIL_LINES) tail.shift();
          }
        });
      }

      conn.onerror = (error: Error) => {
        if (generation !== this.#generation) return;
        this.#lastError.set(server, redactDiagnosticText(error.message));
        this.#log.error("MCP connection error", error, {
          event: "mcp.connection_error",
          mcpServer: server,
        });
      };
      conn.onclose = () => this.#onClose(server, generation, onCrash);
    }
  }

  disarm(): void {
    // client.close() invokes onclose, so invalidate handlers before intentional teardown.
    this.#generation++;
  }

  snapshot(): Record<string, McpServerHealth> {
    const out: Record<string, McpServerHealth> = {};
    for (const [server, health] of this.#health) {
      out[server] = { ...health, ...(health.stderrTail ? { stderrTail: [...health.stderrTail] } : {}) };
    }
    return out;
  }

  #onClose(server: string, generation: number, onCrash: (server: string) => void): void {
    if (generation !== this.#generation) return;
    const current = this.#health.get(server);
    if (!current || current.status === "crashed") return;
    this.#health.set(server, {
      status: "crashed",
      toolCount: 0,
      crashedAt: new Date().toISOString(),
      detail: this.#lastError.get(server) ?? "connection closed unexpectedly",
      ...(this.#stderrTails.get(server)?.length ? { stderrTail: [...this.#stderrTails.get(server)!] } : {}),
    });
    this.#log.error("MCP server connection closed unexpectedly", undefined, {
      event: "mcp.crashed",
      mcpServer: server,
      detail: this.#lastError.get(server) ?? "connection closed unexpectedly",
    });
    onCrash(server);
  }
}
