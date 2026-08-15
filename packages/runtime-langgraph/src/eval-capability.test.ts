import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCatalog } from "@pizza-bot/core";

const mocks = vi.hoisted(() => ({
  createDeepAgent: vi.fn(),
  createSubAgent: vi.fn(),
  createCodeInterpreterMiddleware: vi.fn(),
  modelCallLimitMiddleware: vi.fn(),
  toolCallLimitMiddleware: vi.fn(),
}));

vi.mock("deepagents", async () => {
  const actual = await vi.importActual<typeof import("deepagents")>("deepagents");
  return {
    ...actual,
    createDeepAgent: mocks.createDeepAgent,
    createSubAgent: mocks.createSubAgent,
  };
});

vi.mock("@langchain/quickjs", () => ({
  createCodeInterpreterMiddleware: mocks.createCodeInterpreterMiddleware,
}));

vi.mock("langchain", async () => {
  const actual = await vi.importActual<typeof import("langchain")>("langchain");
  return {
    ...actual,
    modelCallLimitMiddleware: mocks.modelCallLimitMiddleware,
    toolCallLimitMiddleware: mocks.toolCallLimitMiddleware,
  };
});

import { createPizzaBotAgent } from "./index.js";

function mailSkill(interrupt = false): SkillCatalog {
  return new Map([[
    "mailer",
    {
      id: "mailer",
      name: "Mailer",
      description: "Sends mail.",
      source: "user",
      declaredTools: ["mcp:outlook:send"],
      interruptOn: interrupt
        ? { "mcp:outlook:send": { allowedDecisions: ["approve", "edit", "reject"] } }
        : {},
      files: [{
        path: "/skills/mailer/SKILL.md",
        content: "---\nname: Mailer\ndescription: Sends mail.\n---\n\nSend carefully.",
      }],
    },
  ]]);
}

describe("Pizza Bot graph assembly", () => {
  beforeEach(() => {
    mocks.createDeepAgent.mockReset();
    mocks.createDeepAgent.mockResolvedValue({});
    mocks.createSubAgent.mockReset();
    mocks.createSubAgent.mockReturnValue({ compiled: true });
    mocks.createCodeInterpreterMiddleware.mockReset();
    mocks.createCodeInterpreterMiddleware.mockImplementation((options) => ({
      name: "CodeInterpreterMiddleware",
      options,
    }));
    mocks.modelCallLimitMiddleware.mockReset();
    mocks.modelCallLimitMiddleware.mockReturnValue({ name: "ModelCallLimitMiddleware" });
    mocks.toolCallLimitMiddleware.mockReset();
    mocks.toolCallLimitMiddleware.mockReturnValue({ name: "ToolCallLimitMiddleware" });
  });

  it("keeps default delegation and dynamic eval available without skills", async () => {
    await createPizzaBotAgent("prompt", { model: { modelId: "test" } as never });

    const params = mocks.createDeepAgent.mock.calls[0]![0] as {
      middleware: Array<{ name?: string }>;
      subagents?: unknown[];
    };
    expect(params.middleware.map((middleware) => middleware.name)).toContain(
      "DynamicSystemPromptMiddleware",
    );
    expect(params.middleware.map((middleware) => middleware.name)).toEqual(
      expect.arrayContaining([
        "ModelCallLimitMiddleware",
        "ToolCallLimitMiddleware",
      ]),
    );
    expect(mocks.modelCallLimitMiddleware).toHaveBeenCalledWith({
      runLimit: 20,
      exitBehavior: "end",
    });
    expect(mocks.toolCallLimitMiddleware).toHaveBeenCalledWith({
      runLimit: 40,
      exitBehavior: "error",
    });
    expect(params.subagents).toBeUndefined();
    expect(mocks.createCodeInterpreterMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ subagents: true }),
    );
  });

  it("compiles each skill behind its declared tools and HITL policy", async () => {
    const send = { name: "outlook__send" };
    await createPizzaBotAgent("prompt", {
      model: { modelId: "test" } as never,
      checkpointer: {},
      skills: mailSkill(true),
      tools: { "mcp:outlook:send": send },
      catalog: { outlook: ["send"] },
    });

    expect(mocks.createSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [send],
        interruptOn: {
          outlook__send: { allowedDecisions: ["approve", "edit", "reject"] },
        },
      }),
    );
    const subagentParams = mocks.createSubAgent.mock.calls[0]![0] as {
      middleware: Array<{ name?: string }>;
      skills?: string[];
    };
    expect(subagentParams).not.toHaveProperty("skills");
    expect(subagentParams.middleware.map((middleware) => middleware.name))
      .not.toContain("SkillsMiddleware");
    expect(mocks.modelCallLimitMiddleware.mock.calls).toEqual([
      [{ runLimit: 20, exitBehavior: "end" }],
      [{ runLimit: 20, exitBehavior: "end" }],
    ]);
    expect(mocks.toolCallLimitMiddleware.mock.calls).toEqual([
      [{ runLimit: 40, exitBehavior: "error" }],
      [{ runLimit: 80, exitBehavior: "error" }],
    ]);
    const params = mocks.createDeepAgent.mock.calls[0]![0] as {
      subagents: Array<{ runnable: unknown }>;
      skills?: string[];
    };
    expect(typeof (params.subagents[0]!.runnable as { invoke?: unknown }).invoke).toBe("function");
    expect(params.skills).toBeUndefined();
    expect(mocks.createCodeInterpreterMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ subagents: true }),
    );
  });

  it("requires durable checkpoints when a skill enables HITL", async () => {
    await expect(
      createPizzaBotAgent("prompt", {
        model: { modelId: "test" } as never,
        skills: mailSkill(true),
      }),
    ).rejects.toThrow("checkpointer is required for HITL");
  });
});
