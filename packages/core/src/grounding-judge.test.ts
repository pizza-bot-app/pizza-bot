import { describe, expect, it } from "vitest";
import {
  judgeItems,
  judgePrompt,
  parseJudgeResponse,
  pickJudgeModel,
} from "./grounding-judge.js";
import type { PendingJudgement } from "./grounding.js";
import { isGroundingJudgeSetting } from "./settings.js";

const pending = (claim: string, lines = [{ evidenceId: "ev_1", line: 1, text: claim }]): PendingJudgement => ({
  key: claim,
  claim,
  lines,
});

describe("judgeItems", () => {
  it("addresses each claim by a short id and shows the judge only its cited lines, labelled by source", () => {
    const items = judgeItems([
      pending("Renews 2027", [{ evidenceId: "ev_1", line: 2, text: "renewal: 2027" }]),
      pending("Fee $12 refunded", [
        { evidenceId: "ev_1", line: 4, text: "fee 12" },
        { evidenceId: "ev_9", line: 1, text: "refund issued" },
      ]),
    ]);
    expect(items.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(judgePrompt(items)).toContain(
      '<item id="c2">\n<lines>\n[A4] fee 12\n[B1] refund issued\n</lines>\n<claim>Fee $12 refunded</claim>\n</item>',
    );
  });
});

describe("parseJudgeResponse", () => {
  const batch = [pending("a"), pending("b"), pending("c")];
  const items = judgeItems(batch);

  it("maps verdicts back onto the claims they answer", () => {
    const outcomes = parseJudgeResponse(
      {
        verdicts: [
          { id: "c2", verdict: "unsupported", lines: [] },
          { id: "c1", verdict: "supported", lines: ["A1"] },
          { id: "c3", verdict: "unclear", lines: [] },
        ],
      },
      items,
      batch,
    );
    expect(outcomes.get(batch[0]!.key)).toEqual({ verdict: "supported", lines: ["A1"] });
    expect(outcomes.get(batch[1]!.key)).toEqual({ verdict: "unsupported", lines: [] });
    expect(outcomes.get(batch[2]!.key)).toEqual({ verdict: "unclear", lines: [] });
  });

  it("reads a label the judge copied with its brackets as the label itself", () => {
    const outcomes = parseJudgeResponse(
      { verdicts: [{ id: "c1", verdict: "supported", lines: ["[A3]", " [b12] "] }] },
      items,
      batch,
    );
    expect(outcomes.get(batch[0]!.key)).toEqual({ verdict: "supported", lines: ["A3", "B12"] });
  });

  it("fails any claim the answer omits, repeats or misshapes, never reading it as support", () => {
    const outcomes = parseJudgeResponse(
      {
        verdicts: [
          { id: "c1", verdict: "supported", lines: ["A1"] },
          { id: "c1", verdict: "supported", lines: ["A1"] },
          { id: "c2", verdict: "supported", lines: [1] },
        ],
      },
      items,
      batch,
    );
    expect([...outcomes.values()]).toEqual([{ failed: true }, { failed: true }, { failed: true }]);
  });

  it("fails everything when the answer is not the requested shape", () => {
    for (const raw of [undefined, "supported", { verdicts: "all good" }]) {
      expect([...parseJudgeResponse(raw, items, batch).values()].every((o) => "failed" in o)).toBe(true);
    }
  });
});

describe("pickJudgeModel", () => {
  it("judges nothing when claim checking is off, and honours an explicit choice", () => {
    expect(pickJudgeModel("off", "anthropic:claude-opus-5-5", [])).toBeUndefined();
    expect(pickJudgeModel("ollama:qwen3.5:4b", "anthropic:claude-opus-5-5", [])).toBe("ollama:qwen3.5:4b");
  });

  it("picks the newest small model from the default model's provider", () => {
    const available = [
      "anthropic:claude-opus-5-5",
      "anthropic:claude-sonnet-5-5",
      "anthropic:claude-3-5-haiku-20241022",
      "anthropic:claude-haiku-4-5-20251001",
      "openai:gpt-5-mini",
    ];
    expect(pickJudgeModel("auto", "anthropic:claude-opus-5-5", available)).toBe(
      "anthropic:claude-haiku-4-5-20251001",
    );
  });

  it("passes over models too small to judge reliably", () => {
    expect(
      pickJudgeModel("auto", "openai:gpt-5", ["openai:gpt-5", "openai:gpt-5-nano", "openai:gpt-5-mini"]),
    ).toBe("openai:gpt-5-mini");
    expect(
      pickJudgeModel("auto", "ollama:qwen3.5:27b", [
        "ollama:qwen3.5:27b",
        "ollama:qwen3.5:2b",
        "ollama:qwen3.5:0.8b",
        "ollama:qwen3.5:4b",
      ]),
    ).toBe("ollama:qwen3.5:4b");
  });

  it("falls back to the default model when its provider offers no small tier", () => {
    expect(pickJudgeModel("auto", "ollama:llama3.3:70b", ["ollama:llama3.3:70b", "ollama:qwen3.5:2b"])).toBe(
      "ollama:llama3.3:70b",
    );
  });
});

describe("isGroundingJudgeSetting", () => {
  it("accepts off, auto and qualified model ids only", () => {
    expect(isGroundingJudgeSetting("off")).toBe(true);
    expect(isGroundingJudgeSetting("auto")).toBe(true);
    expect(isGroundingJudgeSetting("bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
    expect(isGroundingJudgeSetting("haiku")).toBe(false);
    expect(isGroundingJudgeSetting("")).toBe(false);
    expect(isGroundingJudgeSetting(7)).toBe(false);
  });
});
