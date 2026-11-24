import type { TriggerDef } from "@pizza-bot/core";
import { describeCron } from "../../lib/cron.js";

/** Unnamed triggers fall back to describing what they do. */
export function triggerLabel(trigger: Pick<TriggerDef, "kind" | "name" | "cron">): string {
  if (trigger.name) return trigger.name;
  if (trigger.kind === "cron") return trigger.cron ? describeCron(trigger.cron) : "No expression";
  return "Inbound webhook";
}
