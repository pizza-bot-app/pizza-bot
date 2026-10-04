/** A judge model double: answers each item of a judge prompt with `decide`, counting calls. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { JudgeVerdict, SupportLine } from "@pizza-bot/core";
import type { JudgeModel } from "./grounding-judge.js";

export type Decide = (claim: string, lines: SupportLine[]) => { verdict: JudgeVerdict; lines: number[] };

const ITEM = /<item id="([^"]+)">\n<lines>\n([\s\S]*?)\n<\/lines>\n<claim>([\s\S]*?)<\/claim>\n<\/item>/g;

function parseLines(block: string): SupportLine[] {
  return block.split("\n").flatMap((row) => {
    const match = /^\[(\d+)\] (.*)$/.exec(row);
    return match ? [{ line: Number(match[1]), text: match[2]! }] : [];
  });
}

export function fakeJudge(decide: Decide, id = "test:judge"): JudgeModel & { calls: number } {
  const judge = {
    id,
    calls: 0,
    model: {
      withStructuredOutput: () => ({
        invoke: async (messages: Array<{ content: unknown }>) => {
          judge.calls += 1;
          const prompt = String(messages[messages.length - 1]?.content ?? "");
          return {
            verdicts: [...prompt.matchAll(ITEM)].map(([, itemId, lines, claim]) => ({
              id: itemId,
              ...decide(claim!, parseLines(lines!)),
            })),
          };
        },
      }),
    } as unknown as BaseChatModel,
  };
  return judge;
}

/** Supports every claim with all of the lines it cites. */
export const supportAll: Decide = (_claim, lines) => ({
  verdict: "supported",
  lines: lines.map((line) => line.line),
});
