import { describe, expect, it } from "vitest";
import { ModelRegistry, type SkillCatalog, type SkillCatalogEntry } from "@pizza-bot/core";
import { registerBuiltinProviders } from "@pizza-bot/inference-providers";
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
