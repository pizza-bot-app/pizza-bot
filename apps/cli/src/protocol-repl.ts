import { Client, type AgentServerAdapter, type ThreadStream } from "@langchain/langgraph-sdk";
import type { Event } from "@langchain/protocol";
import { ASSISTANT_ID } from "@pizza-bot/core";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export interface TurnConfig {
  model?: string;
}

function textDeltaOf(ev: Event): string | undefined {
  if (ev.method !== "messages") return undefined;
  const d = ev.params.data as { event?: string; delta?: { type?: string; text?: string } };
  if (d?.event !== "content-block-delta" || d.delta?.type !== "text-delta") return undefined;
  return d.delta.text ?? "";
}

function isRootTerminal(ev: Event): boolean {
  if (ev.method !== "lifecycle" || ev.params.namespace.length !== 0) return false;
  const d = ev.params.data as { event?: string };
  return d?.event === "completed" || d?.event === "failed";
}

export async function renderProtocolTurn(
  client: Client,
  threadId: string,
  text: string,
  stdout: NodeJS.WriteStream,
  cfg: TurnConfig = {},
  transport?: AgentServerAdapter,
): Promise<void> {
  const thread: ThreadStream = client.threads.stream(threadId, {
    assistantId: ASSISTANT_ID,
    ...(transport ? { transport } : {}),
  });
  const configurable: Record<string, string> = { thread_id: threadId };
  if (cfg.model) configurable.model = cfg.model;

  stdout.write("\x1b[33mbot › \x1b[0m");
  let wroteText = false;

  // Submit before subscribing so observe() binds to this run, not a completed run
  // awaiting eviction. Server-side sequence buffering replays any earlier frames.
  await thread.submitRun({ input: { messages: [{ role: "user", content: text }] }, config: { configurable } });

  const sub = await thread.subscribe(["messages", "tools", "lifecycle", "input"]);

  try {
    for await (const ev of sub) {
      const delta = textDeltaOf(ev);
      if (delta) {
        stdout.write(delta);
        wroteText = true;
        continue;
      }
      if (ev.method === "messages") {
        const d = ev.params.data as { event?: string; message?: string; code?: string };
        if (d?.event === "error") stdout.write(red(`\n  [error: ${d.message ?? "unknown"}]`));
        continue;
      }
      if (ev.method === "tools") {
        const d = ev.params.data as { event?: string; tool_name?: string; input?: unknown; output?: unknown; message?: string };
        if (d?.event === "tool-started") {
          const label = d.tool_name === "task" ? "delegate" : `tool → ${d.tool_name}`;
          stdout.write(dim(`\n  [${label}(${JSON.stringify(d.input ?? {})})]\n`));
        } else if (d?.event === "tool-finished") {
          stdout.write(dim(`  [tool ← ${JSON.stringify(d.output)}]\n`));
        } else if (d?.event === "tool-error") {
          stdout.write(red(`\n  [tool error: ${d.message ?? "unknown"}]\n`));
        }
        continue;
      }
      if (ev.method === "input.requested") {
        // CLI mode reports HITL pauses but does not collect a decision.
        const d = ev.params.data as { payload?: unknown };
        stdout.write(dim(`\n  [paused for human approval: ${JSON.stringify(d?.payload ?? {})}]\n`));
        stdout.write(dim("  (HITL decisions aren't supported in CLI protocol mode)\n"));
        break;
      }
      if (ev.method === "lifecycle") {
        const d = ev.params.data as { event?: string; error?: string };
        if (ev.params.namespace.length === 0 && d?.event === "failed") {
          stdout.write(red(`\n  [run failed: ${d.error ?? "unknown"}]`));
        }
        if (isRootTerminal(ev)) break;
      }
    }
  } catch (err) {
    stdout.write(red(`\n  [stream failed: ${err instanceof Error ? err.message : String(err)}]`));
  } finally {
    await sub.unsubscribe().catch(() => void 0);
    await thread.close().catch(() => void 0);
  }

  if (!wroteText) stdout.write(dim("(no text)"));
  stdout.write("\n\n");
}

export function buildProtocolClient(baseUrl: string, apiToken?: string): Client {
  const token = apiToken?.trim();
  return new Client({
    apiUrl: baseUrl.replace(/\/$/, ""),
    ...(token ? { defaultHeaders: { authorization: `Bearer ${token}` } } : {}),
  });
}
