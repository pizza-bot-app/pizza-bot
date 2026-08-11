import { z } from "zod";

export const threadActivityOutcomeSchema = z.enum([
  "success",
  "error",
  "timeout",
  "interrupted",
  "cancelled",
]);
export type ThreadActivityOutcome = z.infer<
  typeof threadActivityOutcomeSchema
>;

export const threadActivityEventSchema = z.object({
  seq: z.number().int().positive(),
  eventId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  outcome: threadActivityOutcomeSchema,
  interruptIds: z.array(z.string()),
  threadTitle: z.string(),
  createdAt: z.string(),
});
export type ThreadActivityEvent = z.infer<typeof threadActivityEventSchema>;

export const threadActivityReadySchema = z.object({
  cursor: z.number().int().nonnegative(),
});
