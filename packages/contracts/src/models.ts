import { z } from 'zod';
import { EffortLevelSchema } from './config.js';

/** The model-picker descriptor surfaced by the engine's `listModels()`. */

/**
 * A model the harness can switch to, as surfaced by the engine's `listModels()`.
 * Mirrors the Claude Agent SDK's `ModelInfo`, restated here so surfaces can
 * render a model picker (and the per-model effort levels) without importing the
 * SDK. The list is **dynamic** — fetched at runtime from the SDK rather than
 * hardcoded — so a new model or effort level appears without a Nightcore release.
 */
export const ModelDescriptorSchema = z.object({
  /** Model id passed to `setModel()` / the SDK (e.g. `claude-opus-4-8`). */
  value: z.string(),
  /** Human-readable name for the picker. */
  displayName: z.string(),
  /** Short capability description. */
  description: z.string(),
  /** Whether this model honors the `effort` option at all. */
  supportsEffort: z.boolean().default(false),
  /** The effort levels this specific model supports (subset of EffortLevel). */
  supportedEffortLevels: z.array(EffortLevelSchema).default([]),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;
