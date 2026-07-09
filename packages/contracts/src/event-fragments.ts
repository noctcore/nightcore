/**
 * Shared event-schema fragments for the scan-event families (`analysis-*`,
 * `harness-*`, `scorecard-*`, `pr-review-*`, `issue-validation-*`), which live
 * beside their payload schemas in the per-feature files. They are spread (not
 * composed as sub-schemas) so the emitted zod object shapes — and therefore the
 * generated Rust — stay identical to inlining the fields. Kept OUT of `events.ts`
 * so a feature file never has to import the union-assembly module (which imports
 * every feature file — that would be a cycle).
 */
import { z } from 'zod';

/** Token usage for a completed session/run, distilled from the SDK result
 *  message. Re-exported through `events.ts` (its historical home) so the barrel
 *  surface is unchanged. */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
  reasoningOutputTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** The run-totals tail shared by every scan family's terminal `*-completed` event. */
export const runTotals = {
  costUsd: z.number(),
  durationMs: z.number().nonnegative().default(0),
  usage: TokenUsageSchema.optional(),
};

/** The reason/message pair shared by the `analysis`/`harness`/`scorecard` `*-failed`
 *  events. The single `reason` value-set collapses to ONE generated Rust enum, the
 *  same collapse the three inline copies produced. (`pr-review-failed` /
 *  `issue-validation-failed` keep a free `z.string()` reason and do NOT use this.) */
export const scanFailure = {
  reason: z.enum(['aborted', 'runner-crash', 'unknown']),
  message: z.string(),
};
