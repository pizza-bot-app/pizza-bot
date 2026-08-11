import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";

interface McpServerStatus {
  name: string;
  status: "loading" | "retrying" | "loaded" | "error" | "crashed" | "disabled";
  toolCount: number;
  crashedAt?: string;
  detail?: string;
  stderrTail?: string[];
}

interface InferenceProviderStatus {
  name: string;
  status: "connected" | "unavailable";
  modelCount: number;
}

export function statusRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    await host.whenReady();
    const [rows, providerRows, catalog] = await Promise.all([
      host.listMcpServers(),
      host.listProviders(),
      host.listModelCatalog(true),
    ]);
    const health = host.mcpHealthSnapshot();
    const servers: McpServerStatus[] = rows.map((row) => ({
      name: row.id,
      status: row.status === "connected" ? "loaded" : row.status,
      toolCount: row.toolCount,
      ...(row.crashedAt ? { crashedAt: row.crashedAt } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(health[row.id]?.stderrTail ? { stderrTail: health[row.id]!.stderrTail } : {}),
    }));

    const loaded = servers.filter((s) => s.status === "loaded").length;
    const disabled = servers.filter((s) => s.status === "disabled").length;
    const total = servers.length - disabled;
    const modelCounts = new Map<string, number>();
    for (const model of catalog.models) {
      modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
    }
    const providers: InferenceProviderStatus[] = providerRows.map((provider) => {
      const modelCount = modelCounts.get(provider.id) ?? 0;
      const configured =
        provider.availableWithoutConfig ||
        host.providerConfigs.getConfig(provider.id) !== undefined;
      return {
        name: provider.id,
        status: configured && modelCount > 0 ? "connected" : "unavailable",
        modelCount,
      };
    });
    const connectedProviders = providers.filter(
      (provider) => provider.status === "connected",
    ).length;

    const contextWindow = await host.contextWindow();

    return c.json({
      model: host.modelId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(contextWindow ? { contextWindow } : {}),
      inference: {
        available: connectedProviders > 0,
        connected: connectedProviders,
        total: providers.length,
        providers,
      },
      mcp: {
        available: total > 0 && loaded === total,
        loaded,
        total,
        disabled,
        servers,
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/models", async (c) => {
    const includeDisabled = c.req.query("include_disabled") === "true";
    const refresh = c.req.query("refresh") === "true";
    const catalog = await host.listModelCatalog(includeDisabled, refresh);
    return c.json({
      models: catalog.models,
      providers: catalog.providers,
      default: host.modelId,
    });
  });

  return app;
}
