import { describe, expect, it } from "vitest";
import {
  ModelRegistry,
  type ModelProvider,
  type SkillCatalog,
  type SkillCatalogEntry,
} from "@pizza-bot/core";
import { registerBuiltinProviders, UnavailableChatModel } from "@pizza-bot/inference-providers";
import { GraphManager } from "./graph-manager.js";

const MODEL_ID = "bedrock:global.anthropic.claude-sonnet-5";
const OTHER_MODEL_ID = "bedrock:global.anthropic.claude-opus-5";

function skillCatalog(...ids: string[]): SkillCatalog {
  const entries: Array<[string, SkillCatalogEntry]> = ids.map((id) => [
    id,
    {
      id,
      name: id,
      description: `${id} description`,
      source: "user",
      declaredTools: [],
      interruptOn: {},
      files: [{
        path: `/skills/${id}/SKILL.md`,
        content: `---\nname: ${id}\ndescription: ${id} description\n---\n\n# ${id}`,
      }],
    },
  ]);
  return new Map(entries);
}

async function createRegistry(skills?: SkillCatalog): Promise<GraphManager> {
  const models = new ModelRegistry();
  await registerBuiltinProviders(models);
  const registry = new GraphManager({
    modelId: MODEL_ID,
    models,
    dependencies: skills ? { skills } : {},
  });
  await registry.initialize(await models.buildModel(MODEL_ID));
  return registry;
}

describe("GraphManager", () => {
  it("owns the active skill catalog", async () => {
    const skills = skillCatalog("health-report");
    expect((await createRegistry(skills)).skills()).toBe(skills);
  });

  it("caches model variants and invalidates them after capability replacement", async () => {
    const registry = await createRegistry();
    const first = await registry.agentFor(OTHER_MODEL_ID);
    expect(await registry.agentFor(OTHER_MODEL_ID)).toBe(first);

    await registry.replaceCapabilities({ skills: new Map() });
    expect(await registry.agentFor(OTHER_MODEL_ID)).not.toBe(first);
  });

  it("rebuilds the warm graph when its provider context override changes", async () => {
    const registry = await createRegistry();
    const first = registry.agent;

    await registry.setModelOverrides("bedrock", {
      "global.anthropic.claude-sonnet-5": { contextWindow: 32_768 },
    });

    expect(registry.agent).not.toBe(first);
  });

  it("invalidates model variants without rebuilding an unrelated warm graph", async () => {
    const registry = await createRegistry();
    const warm = registry.agent;
    const firstVariant = await registry.agentFor(OTHER_MODEL_ID);

    await registry.setModelOverrides("openai", {
      "private-deployment": { contextWindow: 32_768 },
    });

    expect(registry.agent).toBe(warm);
    expect(await registry.agentFor(OTHER_MODEL_ID)).not.toBe(firstVariant);
  });

  it("restores registry overrides when the warm graph cannot rebuild", async () => {
    let failBuild = false;
    const models = new ModelRegistry();
    const provider: ModelProvider = {
      id: "stub",
      async listModels() {
        return [{
          id: "model",
          provider: "stub",
          displayName: "Model",
          contextWindow: 128_000,
        }];
      },
      async buildModel() {
        if (failBuild) throw new Error("provider unavailable");
        return new UnavailableChatModel();
      },
    };
    models.register(provider);
    const registry = new GraphManager({
      modelId: "stub:model",
      models,
      dependencies: {},
    });
    await registry.initialize(await models.buildModel("stub:model"));
    const warm = registry.agent;
    failBuild = true;

    await expect(registry.setModelOverrides("stub", {
      model: { contextWindow: 32_768 },
    })).rejects.toThrow("provider unavailable");

    expect(models.getModelOverrides("stub")).toBeUndefined();
    expect(registry.agent).toBe(warm);
    await expect(models.listAll()).resolves.toEqual([
      expect.objectContaining({ contextWindow: 128_000 }),
    ]);
  });

  it("allows a requested model absent from provider discovery", async () => {
    const registry = await createRegistry();
    await expect(registry.agentFor("bedrock:custom-inference-profile")).resolves.toBeDefined();
  });

  it("re-points the live default so agentFor(undefined) rebuilds", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    const registry = new GraphManager({ modelId: MODEL_ID, models, dependencies: {} });
    await registry.initialize(await models.buildModel(MODEL_ID));
    const first = await registry.agentFor(undefined);
    expect(registry.defaultModelId()).toBe(MODEL_ID);

    await registry.setDefaultModel(OTHER_MODEL_ID, await models.buildModel(OTHER_MODEL_ID));
    expect(registry.defaultModelId()).toBe(OTHER_MODEL_ID);
    const next = await registry.agentFor(undefined);
    expect(next).not.toBe(first);
  });

  it("does not poison the cache after provider resolution fails", async () => {
    const registry = await createRegistry();
    await expect(registry.agentFor("ghost:does-not-exist")).rejects.toMatchObject({
      name: "ModelUnavailableError",
    });
    await expect(registry.agentFor(OTHER_MODEL_ID)).resolves.toBeDefined();
  });

  it("rebuilds the warm graph when persona settings change", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    let addendum = "Always answer in metric units.";
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {},
      getPersonaAddendum: () => addendum,
    });
    await registry.initialize(await models.buildModel(MODEL_ID));
    const first = registry.agent;

    addendum = "";
    await registry.reloadSettings();
    expect(registry.agent).not.toBe(first);
  });

  it("rebuilds when skill availability context changes", async () => {
    const registry = await createRegistry(skillCatalog("plain"));
    const first = registry.agent;
    await registry.replaceCapabilities({
      skills: new Map(),
      skillAvailability: [{
        id: "obsidian",
        name: "Obsidian",
        status: "loading",
        detail: "obsidian is still loading",
      }],
    });
    expect(registry.agent).not.toBe(first);
    expect(registry.skills()).toBeUndefined();
  });
});
