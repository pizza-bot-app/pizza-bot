/** A judge model double: answers each item of a judge prompt with `decide`, counting calls. */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { JudgeVerdict } from "@pizza-bot/core";
import type { JudgeModel } from "./grounding-judge.js";

export type Decide = (claim: string, source: string) => { verdict: JudgeVerdict; quotes: string[] };

const ITEM = /<item id="([^"]+)">\n<claim>([\s\S]*?)<\/claim>\n<source>\n([\s\S]*?)\n<\/source>\n<\/item>/g;

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
            verdicts: [...prompt.matchAll(ITEM)].map(([, itemId, claim, source]) => ({
              id: itemId,
              ...decide(claim!, source!),
            })),
          };
        },
      }),
    } as unknown as BaseChatModel,
  };
  return judge;
}
