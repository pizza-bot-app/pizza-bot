import { describe, expect, it } from "vitest";
import {
  ModelRegistry,
  type AgentCatalogEntry,
  type SkillCatalog,
  type SkillCatalogEntry,
} from "@pizza-bot/core";
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

  it("rebuilds when agent availability context changes", async () => {
    const registry = await createRegistry(skillCatalog("plain"));
    const first = registry.agent;
    await registry.replaceCapabilities({
      skills: new Map(),
      agentAvailability: [{
        id: "obsidian",
        name: "Obsidian",
        status: "loading",
        detail: "obsidian is still loading",
      }],
    });
    expect(registry.agent).not.toBe(first);
    expect(registry.skills()).toBeUndefined();
  });

  describe("rootAgentFor", () => {
    function agent(id: string, overrides: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
      return {
        id,
        name: id === "researcher" ? "Researcher" : id,
        description: `${id} agent`,
        systemPrompt: `You are ${id}.`,
        source: "user",
        declaredTools: [],
        skills: [],
        interruptOn: {},
        ...overrides,
      };
    }

    async function withAgents(...agents: AgentCatalogEntry[]) {
      const models = new ModelRegistry();
      await registerBuiltinProviders(models);
      const registry = new GraphManager({
        modelId: MODEL_ID,
        models,
        dependencies: {
          agents: new Map(agents.map((entry) => [entry.id, entry])),
          agentAvailability: [
            ...agents.map((entry) => ({ id: entry.id, name: entry.name, status: "ready" as const })),
            { id: "broken", name: "Broken", status: "unavailable" as const, detail: "mail is not configured" },
          ],
        },
      });
      await registry.initialize(await models.buildModel(MODEL_ID));
      return registry;
    }

    it("runs the conversation's model unless the agent pins one", async () => {
      const registry = await withAgents(agent("researcher"), agent("pinned", { model: OTHER_MODEL_ID }));
      expect((await registry.rootAgentFor("researcher", OTHER_MODEL_ID)).modelId).toBe(OTHER_MODEL_ID);
      expect((await registry.rootAgentFor("researcher")).modelId).toBe(MODEL_ID);
      expect((await registry.rootAgentFor("pinned", MODEL_ID)).modelId).toBe(OTHER_MODEL_ID);
    });

    it("caches per agent and model and invalidates after capability replacement", async () => {
      const registry = await withAgents(agent("researcher"));
      const first = await registry.rootAgentFor("researcher");
      expect(await registry.rootAgentFor("researcher")).toBe(first);
      expect((await registry.rootAgentFor("researcher", OTHER_MODEL_ID)).agent).not.toBe(first.agent);

      await registry.replaceCapabilities({ skills: new Map() });
      expect((await registry.rootAgentFor("researcher")).agent).not.toBe(first.agent);
    });

    it("names why an agent cannot run", async () => {
      const registry = await withAgents(agent("researcher"));
      await expect(registry.rootAgentFor("broken")).rejects.toThrow(
        'Agent "Broken" is unavailable: mail is not configured',
      );
      await expect(registry.rootAgentFor("ghost")).rejects.toThrow(/does not exist or is disabled/);
    });
  });
});
