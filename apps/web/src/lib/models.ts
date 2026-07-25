// Shared model + effort option sets. These live in `@/lib` rather
// than a feature folder because both the board's per-task picker and the Settings
// model/effort defaults consume them — the single source of truth for the SDK
// model ids and effort levels sent on the wire.
//
// The VALUES are owned by `@nightcore/contracts` (the zod spine): model ids come
// from `KnownModelSchema`, effort levels from `EffortLevelSchema`. This module
// only adds web-only *display* metadata (labels, tiers, descriptions) keyed off
// those contract enums, plus the per-model effort support map.
//
// The per-model `supportsEffort` / `supportedEfforts` / `adaptive` fields mirror
// the contract `ModelDescriptor` (packages/contracts/src/models.ts) that the
// engine's `listModels()` already returns. Browser-preview stories still use a
// curated static stand-in, while the desktop bridge asks the sidecar for the live
// merged provider catalog.

import type { ModelDescriptor } from '@nightcore/contracts';
import { type EffortLevel, type KnownModel, KnownModelSchema } from '@nightcore/contracts';

/** Capability/cost tier shown as a badge on the model option. */
export type ModelTier = 'Speed' | 'Balanced' | 'Premium';

/** A selectable model in the per-task picker / Settings default. */
export interface ModelOption {
  /** The model id sent on the wire (a contract `KnownModel`, e.g. `claude-opus-4-8`). */
  id: string;
  label: string;
  /** Capability/cost tier badge. */
  tier: ModelTier;
  /** One-line capability description shown under the label. */
  description: string;
  /** Whether this model honors the `effort` option at all (mirrors
   *  `ModelDescriptor.supportsEffort`). */
  supportsEffort: boolean;
  /** The effort levels this specific model surfaces, in display order (a subset of
   *  `EffortLevel`; mirrors `ModelDescriptor.supportedEffortLevels`). */
  supportedEfforts: EffortLevel[];
  /** Whether the model decides its reasoning budget adaptively when no effort is
   *  pinned (Inherit). True for Opus 4.8 / Fable 5. */
  adaptive: boolean;
}

interface ModelMeta {
  label: string;
  tier: ModelTier;
  description: string;
  supportsEffort: boolean;
  supportedEfforts: EffortLevel[];
  adaptive: boolean;
}

/** Display + capability metadata for the known Claude models, keyed off the
 *  contract `KnownModelSchema` so the *value* can't drift — only the metadata.
 *  Exhaustive over `KnownModel`: adding a model to the contract enum without an
 *  entry here is a compile error. The premium tier unlocks the higher effort
 *  levels (`xhigh`/`max`); the SDK silently downgrades any level a model can't
 *  honor, so an over-generous set is safe. */
const MODEL_META: Record<KnownModel, ModelMeta> = {
  'claude-opus-4-8': {
    label: 'Opus 4.8',
    tier: 'Premium',
    description: 'Most capable — adaptive reasoning',
    supportsEffort: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    adaptive: true,
  },
  'claude-sonnet-4-6': {
    label: 'Sonnet 4.6',
    tier: 'Balanced',
    description: 'Balanced speed and depth',
    supportsEffort: true,
    supportedEfforts: ['low', 'medium', 'high'],
    adaptive: false,
  },
  'claude-haiku-4-5': {
    label: 'Haiku 4.5',
    tier: 'Speed',
    description: 'Fastest, lightweight',
    supportsEffort: true,
    supportedEfforts: ['low', 'medium', 'high'],
    adaptive: false,
  },
  'claude-fable-5': {
    label: 'Fable 5',
    tier: 'Premium',
    description: 'Creative generalist',
    supportsEffort: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    adaptive: true,
  },
};

/** The known Claude models for browser-preview fallback, in display order. The
 *  desktop picker uses the live `listModels()` bridge instead. */
const WEB_MODELS: readonly KnownModel[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/** The known Claude model ids, derived from the contract enum (single source of
 *  truth for the values) plus the web display/capability metadata above. */
export const MODEL_OPTIONS: ModelOption[] = WEB_MODELS.map((id) => ({
  id: KnownModelSchema.parse(id),
  ...MODEL_META[id],
}));

/** Codex's degraded fallback when app-server model discovery is unavailable. */
export const CODEX_MODEL_OPTION: ModelOption = {
  id: 'gpt-5-codex',
  label: 'GPT-5 Codex',
  tier: 'Premium',
  description: 'Codex-optimized coding model',
  supportsEffort: true,
  supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  adaptive: false,
};

function descriptorFromOption(option: ModelOption): ModelDescriptor {
  return {
    providerId: option.id.startsWith('claude-') ? 'claude' : 'codex',
    value: option.id,
    displayName: option.label,
    description: option.description,
    supportsEffort: option.supportsEffort,
    supportedEffortLevels: option.supportedEfforts,
  };
}

/** The curated `MODEL_OPTIONS` reshaped as the contract `ModelDescriptor[]` the
 *  model catalog trades in — the SAME currency the live `listModels()` bridge seam
 *  returns. Single-sources the static fallback used by both the ModelSelect sync
 *  seam and the browser-preview `listModels` mock, so the picker can swap the
 *  loader (static → live) without a shape change. Pure. */
export function staticModelDescriptors(): ModelDescriptor[] {
  return MODEL_OPTIONS.map(descriptorFromOption);
}

export function codexStaticModelDescriptors(): ModelDescriptor[] {
  return [descriptorFromOption(CODEX_MODEL_OPTION)];
}

/** A selectable reasoning-effort level — the SDK effort set. */
export interface EffortOption {
  /** The effort level sent on the wire. The real levels mirror the contract
   *  `EffortLevelSchema`; `none` is a web-only sentinel that disables extended
   *  thinking (not an SDK `EffortLevel`). */
  id: string;
  label: string;
  /** Short description of what this effort level does (shown as a tooltip). */
  description: string;
}

/** Friendly labels + descriptions for the contract effort levels, keyed off
 *  `EffortLevelSchema` so the level strings can't drift. */
const EFFORT_META: Record<EffortLevel, { label: string; description: string }> = {
  low: { label: 'Low', description: 'Brief consideration' },
  medium: { label: 'Medium', description: 'Balanced reasoning' },
  high: { label: 'High', description: 'Deep, thorough thinking' },
  xhigh: { label: 'Extra high', description: 'Extended deep thinking' },
  max: { label: 'Max', description: 'Maximum reasoning budget' },
};

/** The web-only "disable extended thinking" sentinel. Always offered, regardless
 *  of the selected model — it isn't a model effort level. */
const NONE_EFFORT: EffortOption = { id: 'none', label: 'None', description: 'Skip extended thinking' };

/** The effort levels surfaced when no specific model context is known (Inherit, or
 *  an unrecognized model). The premium higher levels (`xhigh`/`max`) only appear
 *  for models that support them. */
const BASE_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/** The default effort levels the picker surfaces (Inherit context), plus the
 *  `none` sentinel. Retained as a named export for callers that want the base set
 *  without a model context. */
export const EFFORT_OPTIONS: EffortOption[] = [
  ...BASE_EFFORTS.map((id) => ({ id, ...EFFORT_META[id] })),
  NONE_EFFORT,
];

/** Resolve a stored model value to its `ModelOption`. The value may be a canonical
 *  id (`claude-opus-4-8`) or a legacy short id (`opus-4.8`); both match by family.
 *  Returns `null` for Inherit (`null`) or an unrecognized id. Pure. */
export function modelOptionFor(model: string | null): ModelOption | null {
  if (model === null) return null;
  const exact = [...MODEL_OPTIONS, CODEX_MODEL_OPTION].find((option) => option.id === model);
  if (exact !== undefined) return exact;
  const family = model.toLowerCase();
  const match = MODEL_OPTIONS.find((option) => {
    const f = option.label.toLowerCase().split(' ')[0] ?? '';
    return f.length > 0 && family.includes(f);
  });
  return match ?? null;
}

/** The effort options to surface for a model selection. Inherit (`null`) or an
 *  unrecognized model → the base set; a known model → its `supportedEfforts` (or
 *  the base set if it ignores effort entirely). `none` is always appended. Mirrors
 *  the TUI's `supportedEffortLevels`-driven picker. Pure. */
export function effortOptionsForModel(model: string | null): EffortOption[] {
  const option = modelOptionFor(model);
  const levels = option !== null && option.supportsEffort ? option.supportedEfforts : BASE_EFFORTS;
  return effortOptionsForLevels(levels);
}

export function effortOptionsForLevels(levels: readonly EffortLevel[]): EffortOption[] {
  return [...levels.map((id) => ({ id, ...EFFORT_META[id] })), NONE_EFFORT];
}

/** Whether selecting `model` leaves reasoning adaptive when effort is Inherit
 *  (true for Opus 4.8 / Fable 5). Pure. */
export function isAdaptiveModel(model: string | null): boolean {
  return modelOptionFor(model)?.adaptive ?? false;
}

/** Resolve a stored model value to a short display label for the scan-config
 *  hints. Inherit (`null`) reads "the inherited model"; a known id (canonical,
 *  legacy, or Codex) resolves to its friendly label; an unrecognized id passes
 *  through verbatim. Single source of truth for the Insight / Harness / Scorecard
 *  config hints (previously only Harness resolved a label; the others printed the
 *  raw id). Pure. */
export function modelLabel(model: string | null): string {
  if (model === null) return 'the inherited model';
  return modelOptionFor(model)?.label ?? model;
}

/** Whether `effort` is valid for `model`. Inherit (`null`) and the `none` sentinel
 *  are always valid (they aren't model effort levels). Used to reconcile a pinned
 *  effort when the model changes — e.g. `max` is invalid once you leave Opus.
 *  Pure. */
export function isEffortSupported(model: string | null, effort: string | null): boolean {
  if (effort === null || effort === 'none') return true;
  return effortOptionsForModel(model).some((option) => option.id === effort);
}

export function isEffortSupportedByLevels(
  levels: readonly EffortLevel[],
  effort: string | null,
): boolean {
  if (effort === null || effort === 'none') return true;
  return levels.some((level) => level === effort);
}
