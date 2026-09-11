import { Hono } from "hono";
import {
  isMaxToolCalls,
  isPromptAddendum,
  isThemePreference,
  type AppSettingsPatch,
} from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

export function settingsRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/settings", (c) => c.json(host.settings.get()));

  app.put("/settings", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: AppSettingsPatch = {};
    if (isThemePreference(raw.theme)) patch.theme = raw.theme;
    if (isPromptAddendum(raw.customPromptAddendum)) patch.customPromptAddendum = raw.customPromptAddendum;
    if (typeof raw.enableMemories === "boolean") patch.enableMemories = raw.enableMemories;
    if (typeof raw.enableAutomations === "boolean") patch.enableAutomations = raw.enableAutomations;
    if (isMaxToolCalls(raw.maxToolCalls)) patch.maxToolCalls = raw.maxToolCalls;
    if (isMaxToolCalls(raw.maxSkillToolCalls)) patch.maxSkillToolCalls = raw.maxSkillToolCalls;

    const before = host.settings.get();
    const settings = host.settings.patch(patch);
    // Await prompt-affecting rebuilds so the next turn cannot use stale settings.
    // The backend's live gate separately revokes memory I/O from active graphs.
    if (
      settings.customPromptAddendum !== before.customPromptAddendum ||
      settings.enableMemories !== before.enableMemories ||
      settings.maxToolCalls !== before.maxToolCalls ||
      settings.maxSkillToolCalls !== before.maxSkillToolCalls
    ) {
      await host.reloadSettings();
    }
    if (settings.enableAutomations !== before.enableAutomations) {
      host.triggerService.reload();
    }
    return c.json(settings);
  });

  return app;
}
