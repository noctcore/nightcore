/**
 * Decompose result parsing.
 *
 * A `decompose`-kind session investigates read-only and proposes sub-tasks. The
 * PREFERRED source is the Claude Agent SDK's NATIVE structured output: the run is
 * launched with `outputFormat` ({@link DECOMPOSE_OUTPUT_FORMAT}), so the SDK forces
 * the model to return a schema-conforming `{ subtasks }` object (retrying
 * non-conforming output internally) and hands it back on the result message's
 * `structured_output`. {@link subtasksFromStructuredOutput} validates that object
 * against the contract schema. When `structured_output` is ABSENT — an older
 * transcript or a provider that didn't honor `outputFormat` — the engine falls back
 * to {@link parseSubtasks}, which pulls a JSON array out of the final result TEXT
 * (mirrors the Insight findings pipeline: `extractJson` → coerce to array → validate
 * each element → drop anything that can't satisfy the schema).
 *
 * Kept pure (only zod + the shared extractor, no SDK import) and tolerant by design —
 * malformed or empty input yields `[]`, never throws — so a decompose run can never
 * crash the session-completed emit.
 */
import { z } from 'zod';

import { extractJson, toRawArray } from '../scans/shared/findings.js';

/** One proposed sub-task: a short imperative `title` + a self-contained `prompt`.
 *  This IS the element shape of the optional `proposedSubtasks` array on the
 *  `session-completed` event. */
const ProposedSubtaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
});

export type ProposedSubtask = z.infer<typeof ProposedSubtaskSchema>;

/**
 * The SDK `Options.outputFormat` for a decompose session — a JSON-Schema request
 * that makes the SDK return native structured output conforming to
 * `{ subtasks: [{ title, prompt }] }` (and retry non-conforming output internally,
 * failing terminally with `error_max_structured_output_retries` rather than
 * silently emitting prose). Mirrors {@link ProposedSubtaskSchema} field-for-field.
 *
 * Structured-output schemas require `additionalProperties: false` at every object
 * level. Typed structurally (not via the SDK's `OutputFormat`) so this module stays
 * SDK-import-free and unit-testable in isolation; the shape is assignable to
 * `OutputFormat` at the preset/options seam.
 */
export const DECOMPOSE_OUTPUT_FORMAT: {
  type: 'json_schema';
  schema: Record<string, unknown>;
} = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['title', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['subtasks'],
    additionalProperties: false,
  },
};

/** Validate raw sub-task items against the contract schema, dropping any that
 *  fail it or carry a blank/whitespace `title` (a titleless proposal can't become
 *  a board task). Shared by the structured-output and text-parse paths so the two
 *  can never diverge. Never throws. */
function sanitizeSubtasks(items: unknown[]): ProposedSubtask[] {
  const subtasks: ProposedSubtask[] = [];
  for (const item of items) {
    const parsed = ProposedSubtaskSchema.safeParse(item);
    if (!parsed.success) continue;
    if (parsed.data.title.trim().length === 0) continue;
    subtasks.push(parsed.data);
  }
  return subtasks;
}

/**
 * Validated sub-task proposals from the SDK's native `structured_output` (the
 * result message's schema-conforming object built from {@link
 * DECOMPOSE_OUTPUT_FORMAT}). Returns the clean array — possibly `[]` when the run
 * legitimately proposed nothing — whenever structured output is PRESENT, and
 * `undefined` when it is ABSENT (`null`/`undefined`), which signals the caller to
 * fall back to text parsing ({@link parseSubtasks}). Tolerant of shape: it accepts
 * the `{ subtasks: [...] }` wrapper or a bare array via the shared `toRawArray`.
 * Never throws.
 */
export function subtasksFromStructuredOutput(
  structuredOutput: unknown,
): ProposedSubtask[] | undefined {
  if (structuredOutput === null || structuredOutput === undefined) {
    return undefined;
  }
  return sanitizeSubtasks(toRawArray(structuredOutput, 'subtasks'));
}

/**
 * Parse a decompose session's final result TEXT into validated sub-task proposals —
 * the fallback path when the SDK returned no native `structured_output`. Returns the
 * clean array — empty on ANY failure (no JSON, malformed JSON, no valid items).
 * Never throws.
 */
export function parseSubtasks(result: string): ProposedSubtask[] {
  if (typeof result !== 'string') return [];
  return sanitizeSubtasks(toRawArray(extractJson(result), 'subtasks'));
}
