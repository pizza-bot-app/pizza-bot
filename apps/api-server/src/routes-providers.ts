import { Hono } from "hono";
import {
  envReferenceName,
  isEnvReference,
  type ProviderAuthMethod,
  type ProviderModelPreferences,
  type SavedProviderConfig,
} from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

// Password values are never returned to clients. This sentinel retains a stored
// reference without requiring the client to read and resubmit it.
const SECRET_UNCHANGED = "__unchanged__";

type RedactedValue = { hasValue: boolean; available?: boolean } | string;

interface ProviderView {
  id: string;
  configurable: boolean;
  availableWithoutConfig: boolean;
  authSchema?: readonly ProviderAuthMethod[];
  config?: { method: string; values: Record<string, RedactedValue> };
  modelPreferences: ProviderModelPreferences;
}

function secretKeys(authSchema?: readonly ProviderAuthMethod[]): Set<string> {
  const keys = new Set<string>();
  for (const method of authSchema ?? []) {
    for (const field of method.fields) if (field.type === "password") keys.add(field.key);
  }
  return keys;
}

export function providerRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/providers", async (c) => {
    const providers = await host.listProviders();
    const saved = host.providerConfigs.listConfigs();
    const views: ProviderView[] = providers.map((p) => {
      const config = saved[p.id];
      const secrets = secretKeys(p.authSchema);
      return {
        id: p.id,
        configurable: p.configurable,
        availableWithoutConfig: p.availableWithoutConfig,
        ...(p.authSchema ? { authSchema: p.authSchema } : {}),
        ...(config
          ? {
              config: {
                method: config.method,
                values: redactValues(config.values, secrets),
              },
            }
          : {}),
        modelPreferences: host.providerConfigs.getModelPreferences(p.id) ?? {
          mode: "all",
          selected: [],
        },
      };
    });
    return c.json({ providers: views });
  });

  // Keep literal routes before /providers/:id.
  app.get("/providers/default", (c) => {
    return c.json({ default: host.providerConfigs.getDefaultModel() ?? null });
  });

  app.put("/providers/default", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as { default?: unknown };
    if (raw.default !== null && typeof raw.default !== "string") {
      return c.json({ error: "Body must be { default: string | null }." }, 400);
    }
    try {
      await host.setDefaultModel(raw.default);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json({ default: host.providerConfigs.getDefaultModel() ?? null });
  });

  app.put("/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    const provider = (await host.listProviders()).find((candidate) => candidate.id === id);
    if (!provider) return c.json({ error: `Unknown provider "${id}".` }, 404);
    const raw = (await c.req.json().catch(() => ({}))) as {
      mode?: unknown;
      selected?: unknown;
    };
    if (
      (raw.mode !== "all" && raw.mode !== "selected") ||
      !Array.isArray(raw.selected) ||
      !raw.selected.every((modelId) =>
        typeof modelId === "string" &&
        modelId.length > 0 &&
        modelId.length <= 512
      ) ||
      raw.selected.length > 5_000
    ) {
      return c.json({ error: "Body must be { mode: \"all\" | \"selected\", selected: string[] }." }, 400);
    }
    const preferences: ProviderModelPreferences = {
      mode: raw.mode,
      selected: [...new Set(raw.selected)],
    };
    await host.setProviderModelPreferences(id, preferences);
    return c.json(preferences);
  });

  app.put("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const providers = await host.listProviders();
    const provider = providers.find((p) => p.id === id);
    if (!provider) return c.json({ error: `Unknown provider "${id}".` }, 404);

    const raw = (await c.req.json().catch(() => ({}))) as {
      method?: unknown;
      values?: unknown;
    };
    if (typeof raw.method !== "string" || !raw.values || typeof raw.values !== "object") {
      return c.json({ error: "Body must be { method: string, values: object }." }, 400);
    }
    const incoming = raw.values as Record<string, unknown>;
    const method = provider.authSchema?.find((candidate) => candidate.id === raw.method);
    if (provider.authSchema && !method) {
      return c.json({ error: `Unknown configuration method "${raw.method}".` }, 400);
    }
    const secrets = secretKeys(provider.authSchema);
    const existing = host.providerConfigs.getConfig(id);

    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value !== "string") continue;
      if (secrets.has(key)) {
        if (value === SECRET_UNCHANGED) {
          const prior = existing?.values[key];
          if (prior !== undefined) values[key] = prior;
          continue;
        }
        // The server is the trust boundary: a secret may only be persisted as an
        // `${ENV_REF}`, never a raw value, so plaintext keys never reach SQLite.
        if (!isEnvReference(value)) {
          return c.json(
            {
              error: `Secret field "${key}" must be an \${ENV_REF} reference, not a literal value.`,
            },
            400,
          );
        }
      }
      values[key] = value;
    }
    const missing = method?.fields.find(
      (field) => field.required && !values[field.key]?.trim(),
    );
    if (missing) {
      return c.json({ error: `Required field "${missing.label}" is missing.` }, 400);
    }

    const config: SavedProviderConfig = { method: raw.method, values };
    // Apply live first so a config that fails to build never reaches storage.
    try {
      await host.configureProvider(id, config);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    host.providerConfigs.setConfig(id, config);
    return c.json({
      id,
      config: { method: config.method, values: redactValues(config.values, secrets) },
    });
  });

  app.delete("/providers/:id", async (c) => {
    const id = c.req.param("id");
    host.providerConfigs.removeConfig(id);
    await host.clearProviderModelPreferences(id);
    return c.json({ ok: true });
  });

  return app;
}

function redactValues(
  values: Record<string, string>,
  secrets: Set<string>,
): Record<string, RedactedValue> {
  const out: Record<string, RedactedValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!secrets.has(key)) {
      out[key] = value;
      continue;
    }
    const envName = envReferenceName(value);
    out[key] = {
      hasValue: value.length > 0,
      available: envName !== undefined && Boolean(process.env[envName]),
    };
  }
  return out;
}
