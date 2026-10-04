/**
 * Grades cited claims with the configured judge model while an action waits for a human.
 * A judgement is cached per (judge, evidence entry, claim), so the live card, an edit that
 * keeps the claim, and the durable record all read the same answer.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  JUDGE_BATCH,
  JUDGE_RESPONSE_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  auditGroundingSpans,
  citedEvidenceIds,
  judgeItems,
  judgePrompt,
  parseInterruptActions,
  parseJudgeResponse,
  pendingJudgements,
  type ApprovalVerdictSpan,
  type CitedSource,
  type JudgeOutcome,
  type PendingJudgement,
  type ThreadState,
} from "@pizza-bot/core";
import type { EvidenceStore } from "@pizza-bot/storage";

export interface JudgeModel {
  /** Qualified `provider:model` id, recorded with every tier the judge decides. */
  id: string;
  model: BaseChatModel;
}

export interface GroundingJudgeDeps {
  evidence?: EvidenceStore | undefined;
  /** The configured judge; `undefined` when claim checking is off. */
  resolveJudge: () => Promise<JudgeModel | undefined>;
  timeoutMs?: number;
}

export interface GroundingAudit {
  /** The judge that graded these spans, or `null` when claim checking is off. */
  judge: string | null;
  spans: ApprovalVerdictSpan[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CACHED = 2_000;
const FAILED: JudgeOutcome = { failed: true };

export class GroundingJudge {
  private readonly cache = new Map<string, Promise<JudgeOutcome>>();

  constructor(private readonly deps: GroundingJudgeDeps) {}

  /** Grades one action's arguments against this thread's ledger. Never throws. */
  async audit(threadId: string, args: unknown): Promise<GroundingAudit> {
    const { sources, identities } = this.citedSources(threadId, args);
    let judge: JudgeModel | undefined;
    let unavailable = false;
    try {
      judge = await this.deps.resolveJudge();
    } catch (err) {
      console.error("[grounding] judge model unavailable:", err);
      unavailable = true;
    }
    const pending = pendingJudgements(args, sources);
    const judgeId = judge?.id ?? (unavailable ? "unavailable" : undefined);
    const outcomes = new Map<string, JudgeOutcome>();
    if (judge) {
      const settled = await this.judge(judge, pending);
      for (const [key, outcome] of settled) outcomes.set(key, outcome);
    } else if (unavailable) {
      for (const item of pending) outcomes.set(item.key, FAILED);
    }
    const audited = auditGroundingSpans(
      args,
      sources,
      judgeId ? { judge: judgeId, outcomes } : undefined,
    );
    return {
      judge: judgeId ?? null,
      spans: audited.map((span) => ({
        ...span,
        cites: span.cites.map((cite) => ({ ...cite, ...(identities.get(cite.evidenceId) ?? {}) })),
      })),
    };
  }

  /** Each action of a pending interrupt, in order; `undefined` when the interrupt is gone. */
  async auditInterrupt(
    threadId: string,
    state: ThreadState,
    interruptId: string,
  ): Promise<GroundingAudit[] | undefined> {
    const interrupt = state.interrupts?.find((candidate) => candidate.id === interruptId);
    if (!interrupt) return undefined;
    const { actions } = parseInterruptActions(interrupt.value);
    return Promise.all(actions.map((action) => this.audit(threadId, action.args)));
  }

  /** Starts grading every pending interrupt so the card has its answer before it asks. */
  prewarm(threadId: string, state: ThreadState): void {
    for (const interrupt of state.interrupts ?? []) {
      void this.auditInterrupt(threadId, state, interrupt.id);
    }
  }

  private citedSources(threadId: string, args: unknown) {
    const sources = new Map<string, CitedSource>();
    const identities = new Map<string, { breadcrumb: string; bytes: number; truncated: boolean }>();
    for (const id of citedEvidenceIds(args)) {
      // A citation naming another thread's entry is not this thread's evidence.
      const entry = this.deps.evidence?.get(id);
      if (!entry || entry.threadId !== threadId) continue;
      identities.set(id, { breadcrumb: entry.breadcrumb, bytes: entry.bytes, truncated: entry.truncated });
      const text = this.deps.evidence?.readBody(id);
      if (text !== undefined) sources.set(id, { text, truncated: entry.truncated });
    }
    return { sources, identities };
  }

  private async judge(
    judge: JudgeModel,
    pending: readonly PendingJudgement[],
  ): Promise<Map<string, JudgeOutcome>> {
    const outcomes = new Map<string, Promise<JudgeOutcome>>();
    const uncached: PendingJudgement[] = [];
    for (const item of pending) {
      const cached = this.cache.get(cacheKey(judge, item));
      if (cached) outcomes.set(item.key, cached);
      else uncached.push(item);
    }
    for (let start = 0; start < uncached.length; start += JUDGE_BATCH) {
      const batch = uncached.slice(start, start + JUDGE_BATCH);
      const call = this.call(judge, batch);
      for (const item of batch) {
        const key = cacheKey(judge, item);
        const outcome = call.then((settled) => settled.get(item.key) ?? FAILED);
        outcomes.set(item.key, outcome);
        this.remember(key, outcome);
        // A failure is retried on the next read rather than pinned for the session.
        void outcome.then((settled) => {
          if ("failed" in settled && this.cache.get(key) === outcome) this.cache.delete(key);
        });
      }
    }
    const settled = await Promise.all(
      [...outcomes].map(async ([key, outcome]) => [key, await outcome] as const),
    );
    return new Map(settled);
  }

  private async call(
    judge: JudgeModel,
    batch: readonly PendingJudgement[],
  ): Promise<Map<string, JudgeOutcome>> {
    const items = judgeItems(batch);
    try {
      const structured = judge.model.withStructuredOutput(JUDGE_RESPONSE_SCHEMA, {
        name: "citation_verdicts",
      });
      const raw = await structured.invoke(
        [new SystemMessage(JUDGE_SYSTEM_PROMPT), new HumanMessage(judgePrompt(items))],
        { signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
      );
      return parseJudgeResponse(raw, items, batch);
    } catch (err) {
      console.error(`[grounding] judge ${judge.id} failed:`, err);
      return new Map(batch.map((item) => [item.key, FAILED]));
    }
  }

  private remember(key: string, outcome: Promise<JudgeOutcome>): void {
    this.cache.set(key, outcome);
    if (this.cache.size <= MAX_CACHED) return;
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) this.cache.delete(oldest);
  }
}

function cacheKey(judge: JudgeModel, item: PendingJudgement): string {
  return `${judge.id}\u0000${item.key}`;
}
