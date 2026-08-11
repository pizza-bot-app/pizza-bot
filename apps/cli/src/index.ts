#!/usr/bin/env node
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildProtocolClient, renderProtocolTurn } from "./protocol-repl.js";
import { configureLogging, installProcessErrorHandlers } from "@pizza-bot/logging";

const DEFAULT_SERVER_URL = "http://localhost:8080";
const dataRoot = process.env.PIZZA_DATA_ROOT ?? join(homedir(), ".pizza-bot-oss");
const logger = configureLogging({ processName: "cli", dataRoot, console: false });
installProcessErrorHandlers(logger.child({ component: "process" }));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

type TurnRenderer = (threadId: string, text: string) => Promise<void>;

// The CLI is a thin client over a running server; it never boots a runtime.
function wireTransport(): { render: TurnRenderer; label: string } {
  const modelEnv = process.env.PIZZA_MODEL;
  const cfg = modelEnv ? { model: modelEnv } : {};
  const baseUrl =
    process.env.PIZZA_REMOTE_URL ?? process.env.PIZZA_API_URL ?? DEFAULT_SERVER_URL;
  const client = buildProtocolClient(baseUrl, process.env.PIZZA_API_TOKEN);
  return {
    label: `server ${baseUrl}`,
    render: (threadId, text) => renderProtocolTurn(client, threadId, text, stdout, cfg),
  };
}

async function main(): Promise<void> {
  const { render, label } = wireTransport();
  const threadId = "cli-" + Date.now().toString(36);
  logger.info("CLI session started", { event: "cli.started", threadId });

  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) {
    stdout.write(`${cyan("🍕 Pizza Bot")} ${dim("— " + label)}\n\n`);
    await render(threadId, oneShot);
    return;
  }

  stdout.write(
    `\n${cyan("🍕 Pizza Bot shell")} ${dim("— " + label)}\n` +
      dim("Type a message and press enter. Commands: /exit, /reset, /help\n\n"),
  );

  let thread = threadId;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("SIGINT", () => rl.close());

  // readline must own the prompt so editing keys repaint it correctly.
  rl.setPrompt(green("you › "));
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") break;
    if (text === "/help") {
      stdout.write(dim("  /exit  quit   /reset  new conversation   /help  this\n"));
    } else if (text === "/reset") {
      thread = "cli-" + Date.now().toString(36);
      stdout.write(dim("  (new conversation)\n"));
    } else if (text) {
      await render(thread, text);
    }
    rl.prompt();
  }
  rl.close();
  stdout.write(dim("\n👋 bye\n"));
}

main().catch((err) => {
  logger.error("CLI failed", err, { event: "cli.failed" });
  console.error(red("fatal: " + (err instanceof Error ? err.message : String(err))));
  process.exit(1);
});
