import type { AgentServerAdapter } from "@langchain/langgraph-sdk";
import type { ProtocolEvent } from "@langchain/langgraph";
import type { AgentHandle } from "@pizza-bot/core";
import type { ProtocolFilter, ProtocolRunManager } from "../protocol-run-manager.js";
import {
  type ProtocolCommand,
  dispatchProtocolCommand,
  toProtocolState,
} from "../protocol-commands.js";

type StateReader = Pick<AgentHandle, "getState">;

interface CommandSuccess {
  type: "success";
  id: number;
  result: Record<string, unknown>;
}

interface SubscribeParams {
  channels: string[];
  namespaces?: string[][];
  depth?: number;
  since?: number;
}

interface EventStreamHandle {
  events: AsyncIterable<ProtocolEvent>;
  ready: Promise<void>;
  close(): void;
}

export class InProcessTransport {
  threadId: string;

  constructor(
    private readonly runs: ProtocolRunManager,
    private readonly agent: StateReader,
    threadId = "",
  ) {
    this.threadId = threadId;
  }

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async send(command: ProtocolCommand): Promise<CommandSuccess | void> {
    const outcome = await dispatchProtocolCommand({
      runs: this.runs,
      stateReader: this.agent,
      threadId: this.threadId,
      command,
    });
    if (outcome.kind === "success") {
      return { type: "success", id: outcome.id, result: outcome.result };
    }
    if (outcome.kind === "cancellation_pending") {
      throw new Error("run did not stop before the cancellation deadline");
    }
    if (outcome.kind === "unsupported") {
      throw new Error(`unsupported command method ${JSON.stringify(outcome.method)}`);
    }
  }

  openEventStream(params: SubscribeParams): EventStreamHandle {
    const ac = new AbortController();
    const filter: ProtocolFilter = {
      channels: [...params.channels],
      ...(params.namespaces ? { namespaces: params.namespaces.map((n) => [...n]) } : {}),
      ...(typeof params.depth === "number" ? { depth: params.depth } : {}),
      ...(typeof params.since === "number" ? { since: params.since } : {}),
    };
    const source = this.runs.observe(this.threadId, filter, ac.signal);
    return {
      events: source,
      ready: Promise.resolve(),
      close: () => ac.abort(),
    };
  }

  async getState(): Promise<{ values: unknown; next?: unknown }> {
    const state = await this.agent.getState(this.threadId);
    return toProtocolState(state) as { values: unknown; next?: unknown };
  }

  asAgentServerAdapter(): AgentServerAdapter {
    // The SDK exposes nominally distinct internal and re-exported protocol types;
    // this structural boundary avoids spreading those duplicate types internally.
    return this as unknown as AgentServerAdapter;
  }
}
