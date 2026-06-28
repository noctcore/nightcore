/**
 * Decompose result parsing.
 *
 * A `decompose`-kind session investigates read-only and ends its final message with
 * a JSON array of sub-task proposals. The engine parses that array here and emits
 * validated `proposedSubtasks` on the `session-completed` event. This mirrors how
 * the Insight pipeline turns a category pass's free text into validated findings:
 * reuse the shared `extractJson` extractor, coerce to an array, validate each
 * element against a strict contract schema, and drop anything that can't satisfy it.
 *
 * Kept pure (only zod + the shared extractor) and tolerant by design — malformed or
 * empty input yields `[]`, never throws — so a decompose run can never crash the
 * session-completed emit.
 */
import { z } from 'zod';
import { extractJson } from '../scans/shared/findings.js';

/** One proposed sub-task: a short imperative `title` + a self-contained `prompt`.
 *  This IS the element shape of the optional `proposedSubtasks` array on the
 *  `session-completed` event. */
const ProposedSubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
});

export type ProposedSubtask = z.infer<typeof ProposedSubtaskSchema>;

/** Coerce the extracted JSON to an array of candidate items. The model is
 *  instructed to emit a bare array; tolerate the common `{ "subtasks": [...] }`
 *  wrapper too. Anything else ⇒ no items. */
function toRawArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const subtasks = (parsed as Record<string, unknown>).subtasks;
    if (Array.isArray(subtasks)) return subtasks;
  }
  return [];
}

/**
 * Parse a decompose session's final result text into validated sub-task proposals.
 * Returns the clean array — empty on ANY failure (no JSON, malformed JSON, no valid
 * items). Items whose `title` is empty/whitespace are dropped (a titleless proposal
 * can't become a board task). Never throws.
 */
export function parseSubtasks(result: string): ProposedSubtask[] {
  if (typeof result !== 'string') return [];
  const items = toRawArray(extractJson(result));
  const subtasks: ProposedSubtask[] = [];
  for (const item of items) {
    const parsed = ProposedSubtaskSchema.safeParse(item);
    if (!parsed.success) continue;
    if (parsed.data.title.trim().length === 0) continue;
    subtasks.push(parsed.data);
  }
  return subtasks;
}
