import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";
import type { ProviderModelPreferences } from "@pizza-bot/core";

interface ProviderView {
  id: string;
  configurable: boolean;
  availableWithoutConfig: boolean;
  authSchema?: Array<{
    id: string;
    fields: Array<{ key: string; type: string; options?: Array<{ value: string; label: string }> }>;
  }>;
  config?: {
    method: string;
    values: Record<string, { hasValue: boolean; available?: boolean } | string>;
  };
  modelPreferences: ProviderModelPreferences;
}

describe("provider routes", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("BEDROCK_AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("BEDROCK_AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    dataRoot = mkdtempSync(join(tmpdir(), "route-providers-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "route-providers-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    vi.unstubAllEnvs();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  const put = (id: string, body: unknown) =>
    app.request(`/providers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const list = async () => ((await (await app.request("/providers")).json()) as { providers: ProviderView[] }).providers;
  const putModels = (id: string, body: unknown) =>
    app.request(`/providers/${id}/models`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists all six built-in providers with their authSchema", async () => {
    const providers = await list();
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "bedrock", "google", "ollama", "openai", "openrouter"]);
    const anthropic = providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.configurable).toBe(true);
    expect(anthropic.availableWithoutConfig).toBe(false);
    expect(providers.find((p) => p.id === "openai")!.availableWithoutConfig).toBe(false);
    expect(providers.find((p) => p.id === "openrouter")!.availableWithoutConfig).toBe(false);
    expect(providers.find((p) => p.id === "google")!.availableWithoutConfig).toBe(false);
    expect(providers.find((p) => p.id === "ollama")!.availableWithoutConfig).toBe(true);
    const bedrock = providers.find((p) => p.id === "bedrock")!;
    expect(bedrock.configurable).toBe(true);
    expect(bedrock.availableWithoutConfig).toBe(false);
    expect(bedrock.authSchema?.[0]).toMatchObject({
      id: "aws-profile",
      fields: [
        { key: "profile", type: "select" },
        { key: "region", type: "text" },
      ],
    });
    expect(bedrock.authSchema?.map((method) => method.id)).toEqual([
      "aws-profile",
      "access-keys",
      "bedrock-api-key",
    ]);
    expect(anthropic.modelPreferences).toEqual({ mode: "all", selected: [] });
  });

  it("allows configured cross-origin provider PUT requests", async () => {
    const res = await app.request("/providers/bedrock", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("persists and displays the selected Bedrock profile", async () => {
    const reloadMcpServers = vi.spyOn(host, "reloadMcpServers");
    const res = await put("bedrock", {
      method: "aws-profile",
      values: { profile: "production" },
    });
    expect(res.status).toBe(200);

    const bedrock = (await list()).find((p) => p.id === "bedrock")!;
    expect(bedrock.config).toEqual({
      method: "aws-profile",
      values: { profile: "production" },
    });
    expect(host.providerConfigs.getConfig("bedrock")).toEqual({
      method: "aws-profile",
      values: { profile: "production" },
    });
    expect(reloadMcpServers).toHaveBeenCalledOnce();
    expect(
      (
        host as unknown as {
          providerMcpEnv?: Record<string, string>;
        }
      ).providerMcpEnv?.AWS_PROFILE,
    ).toBe("production");
  });

  it("requires a Bedrock profile before saving configuration", async () => {
    const configureProvider = vi.spyOn(host, "configureProvider");
    const res = await put("bedrock", {
      method: "aws-profile",
      values: {},
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Required field "Profile" is missing.' });
    expect(host.providerConfigs.getConfig("bedrock")).toBeUndefined();
    expect(configureProvider).not.toHaveBeenCalled();
  });

  it("persists Bedrock access-key references and redacts both keys", async () => {
    const res = await put("bedrock", {
      method: "access-keys",
      values: {
        accessKeyId: "${BEDROCK_AWS_ACCESS_KEY_ID}",
        secretAccessKey: "${BEDROCK_AWS_SECRET_ACCESS_KEY}",
        region: "eu-central-1",
      },
    });
    expect(res.status).toBe(200);

    const bedrock = (await list()).find((p) => p.id === "bedrock")!;
    expect(bedrock.config).toEqual({
      method: "access-keys",
      values: {
        accessKeyId: { hasValue: true, available: false },
        secretAccessKey: { hasValue: true, available: false },
        region: "eu-central-1",
      },
    });
    expect(host.providerConfigs.getConfig("bedrock")).toEqual({
      method: "access-keys",
      values: {
        accessKeyId: "${BEDROCK_AWS_ACCESS_KEY_ID}",
        secretAccessKey: "${BEDROCK_AWS_SECRET_ACCESS_KEY}",
        region: "eu-central-1",
      },
    });
  });

  it("persists and redacts a Bedrock API key reference", async () => {
    const res = await put("bedrock", {
      method: "bedrock-api-key",
      values: {
        apiKey: "${AWS_BEARER_TOKEN_BEDROCK}",
        region: "us-east-1",
      },
    });
    expect(res.status).toBe(200);

    const bedrock = (await list()).find((p) => p.id === "bedrock")!;
    expect(bedrock.config).toEqual({
      method: "bedrock-api-key",
      values: {
        apiKey: { hasValue: true, available: false },
        region: "us-east-1",
      },
    });
  });

  it("rejects literal Bedrock access keys", async () => {
    const res = await put("bedrock", {
      method: "access-keys",
      values: {
        accessKeyId: "literal-access-key",
        secretAccessKey: "${BEDROCK_AWS_SECRET_ACCESS_KEY}",
      },
    });

    expect(res.status).toBe(400);
    expect(host.providerConfigs.getConfig("bedrock")).toBeUndefined();
  });

  it("PUT stores an env-ref key and GET redacts it to hasValue", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const reloadMcpServers = vi.spyOn(host, "reloadMcpServers");
    const res = await put("anthropic", {
      method: "api-key",
      values: { apiKey: "${ANTHROPIC_API_KEY}" },
    });
    expect(res.status).toBe(200);

    const anthropic = (await list()).find((p) => p.id === "anthropic")!;
    expect(anthropic.config?.values.apiKey).toEqual({
      hasValue: true,
      available: true,
    });
    expect(JSON.stringify(anthropic.config)).not.toContain("ANTHROPIC_API_KEY");
    expect(reloadMcpServers).not.toHaveBeenCalled();
  });

  it("passes a non-secret field through unredacted", async () => {
    await put("openai", {
      method: "api-key",
      values: { apiKey: "${OPENAI_API_KEY}", baseUrl: "https://proxy.example.com/v1" },
    });
    const openai = (await list()).find((p) => p.id === "openai")!;
    expect(openai.config?.values.baseUrl).toBe("https://proxy.example.com/v1");
    expect(openai.config?.values.apiKey).toEqual({
      hasValue: true,
      available: false,
    });
  });

  it("rejects a raw secret value with 400 and persists nothing", async () => {
    const configureProvider = vi.spyOn(host, "configureProvider");
    const res = await put("anthropic", {
      method: "api-key",
      values: { apiKey: "a-raw-plaintext-value" },
    });
    expect(res.status).toBe(400);
    expect(host.providerConfigs.getConfig("anthropic")).toBeUndefined();
    expect(configureProvider).not.toHaveBeenCalled();
  });

  it("accepts an env-reference secret value", async () => {
    const res = await put("anthropic", {
      method: "api-key",
      values: { apiKey: "${ANTHROPIC_API_KEY}" },
    });
    expect(res.status).toBe(200);
    expect(host.providerConfigs.getConfig("anthropic")?.values.apiKey).toBe("${ANTHROPIC_API_KEY}");
  });

  it("the unchanged sentinel keeps the stored secret", async () => {
    await put("anthropic", { method: "api-key", values: { apiKey: "${ANTHROPIC_API_KEY}" } });
    await put("anthropic", { method: "api-key", values: { apiKey: "__unchanged__" } });
    const anthropic = (await list()).find((p) => p.id === "anthropic")!;
    expect(anthropic.config?.values.apiKey).toEqual({
      hasValue: true,
      available: false,
    });
    expect(host.providerConfigs.getConfig("anthropic")?.values.apiKey).toBe("${ANTHROPIC_API_KEY}");
  });

  it("DELETE forgets a provider's config", async () => {
    await put("anthropic", { method: "api-key", values: { apiKey: "${ANTHROPIC_API_KEY}" } });
    await putModels("anthropic", { mode: "selected", selected: ["claude-test"] });
    const del = await app.request("/providers/anthropic", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await list()).find((p) => p.id === "anthropic")!.config).toBeUndefined();
    expect((await list()).find((p) => p.id === "anthropic")!.modelPreferences)
      .toEqual({ mode: "all", selected: [] });
  });

  it("persists model preferences and applies them to the live catalog", async () => {
    vi.spyOn(host, "listModelCatalog").mockImplementation(async (includeDisabled = false) => {
      const models = [
        { id: "anthropic:claude-a", displayName: "Claude A", provider: "anthropic" },
        { id: "anthropic:claude-b", displayName: "Claude B", provider: "anthropic" },
      ];
      const preferences = host.providerConfigs.getModelPreferences("anthropic");
      return {
        models: !includeDisabled && preferences?.mode === "selected"
          ? models.filter((model) =>
              preferences.selected.includes(model.id.slice("anthropic:".length))
            )
          : models,
        providers: [{
          provider: "anthropic",
          status: "ready",
          modelCount: models.length,
          stale: false,
        }],
      };
    });

    const res = await putModels("anthropic", {
      mode: "selected",
      selected: ["claude-b", "claude-b"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "selected", selected: ["claude-b"] });
    expect((await list()).find((p) => p.id === "anthropic")!.modelPreferences)
      .toEqual({ mode: "selected", selected: ["claude-b"] });
    const models = await (await app.request("/models")).json() as {
      models: Array<{ id: string }>;
    };
    expect(models.models).toEqual([expect.objectContaining({ id: "anthropic:claude-b" })]);
  });

  it("rejects malformed model preferences and unknown providers", async () => {
    expect((await putModels("anthropic", { mode: "selected", selected: "claude" })).status)
      .toBe(400);
    expect((await putModels("nope", { mode: "all", selected: [] })).status).toBe(404);
  });

  it("404s an unknown provider on PUT", async () => {
    const res = await put("nope", { method: "x", values: {} });
    expect(res.status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const res = await put("anthropic", { method: 123 });
    expect(res.status).toBe(400);
  });

  it("gets and sets the default model", async () => {
    const before = await app.request("/providers/default");
    expect((await before.json()) as { default: null }).toEqual({ default: null });

    const set = await app.request("/providers/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: "anthropic:claude-sonnet-5" }),
    });
    expect(((await set.json()) as { default: string }).default).toBe("anthropic:claude-sonnet-5");

    const after = await app.request("/providers/default");
    expect(((await after.json()) as { default: string }).default).toBe("anthropic:claude-sonnet-5");
  });

  const setDefault = (model: string | null) =>
    app.request("/providers/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: model }),
    });

  it("re-points the live default without a restart", async () => {
    const res = await setDefault("anthropic:claude-opus-5");
    expect(res.status).toBe(200);
    expect(host.modelId).toBe("anthropic:claude-opus-5");
    const status = (await (await app.request("/status")).json()) as { model: string };
    expect(status.model).toBe("anthropic:claude-opus-5");
    const models = (await (await app.request("/models")).json()) as { default: string };
    expect(models.default).toBe("anthropic:claude-opus-5");
    const agent = await host.agentFor(undefined);
    expect(agent).toBe(await host.agentFor(undefined));
  });

  it("rejects an unknown default and leaves the live default unchanged", async () => {
    const priorModel = host.modelId;
    const res = await setDefault("ghost:does-not-exist");
    expect(res.status).toBe(400);
    expect(host.modelId).toBe(priorModel);
    expect(host.providerConfigs.getDefaultModel()).toBeUndefined();
  });

  it("does not persist a provider config whose live apply fails", async () => {
    vi.spyOn(host, "configureProvider").mockRejectedValueOnce(new Error("cannot build model"));
    const res = await put("anthropic", { method: "api-key", values: { apiKey: "${ANTHROPIC_API_KEY}" } });
    expect(res.status).toBe(400);
    expect(host.providerConfigs.getConfig("anthropic")).toBeUndefined();
  });
});
