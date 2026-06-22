// Shared model + effort option sets (M4.7 §E/§F). These live in `@/lib` rather
// than a feature folder because both the board's per-task picker and the Settings
// model/effort defaults consume them — the single source of truth for the SDK
// model ids and effort levels sent on the wire.
//
// The VALUES are owned by `@nightcore/contracts` (the zod spine): model ids come
// from `KnownModelSchema`, effort levels from `EffortLevelSchema`. This module
// only adds web-only *display labels*, keyed off those contract enums so a label
// map can never drift on the value — only on the (cosmetic) label. The dynamic
// `listModels()` descriptors (§G) are deferred; until then the curated known set
// is derived from the contract enum rather than re-listed here.

import { EffortLevelSchema, KnownModelSchema, type EffortLevel, type KnownModel } from '@nightcore/contracts';

/** A selectable model in the per-task picker / Settings default. */
export interface ModelOption {
  /** The model id sent on the wire (a contract `KnownModel`, e.g. `claude-opus-4-8`). */
  id: string;
  label: string;
}

/** Friendly display labels for the known Claude models, keyed off the contract
 *  `KnownModelSchema` so the *value* can't drift — only the label. Adding a model
 *  to the contract enum without a label here is a compile error (the `Record` is
 *  exhaustive over `KnownModel`). */
const MODEL_LABELS: Record<KnownModel, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-fable-5': 'Fable 5',
};

/** The known Claude models the picker surfaces, in display order. The ids are
 *  typed as contract `KnownModel`s and validated against `KnownModelSchema` below,
 *  so a value here can't drift from the spine (a typo or removed model is a
 *  compile/runtime error). The web offers a curated subset of the enum; a contract
 *  model not listed here is intentionally not offered this milestone (dynamic
 *  `listModels()` is deferred — §G). */
const WEB_MODELS: readonly KnownModel[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/** The known Claude model ids, derived from the contract enum (single source of
 *  truth for the values) plus the web display labels above. */
export const MODEL_OPTIONS: ModelOption[] = WEB_MODELS.map((id) => ({
  id: KnownModelSchema.parse(id),
  label: MODEL_LABELS[id],
}));

/** A selectable reasoning-effort level — the SDK effort set (contract §E/§F). */
export interface EffortOption {
  /** The effort level sent on the wire. The shared levels mirror the contract
   *  `EffortLevelSchema`; `none` is a web-only sentinel that disables extended
   *  thinking (not an SDK `EffortLevel`). */
  id: string;
  label: string;
}

/** Friendly display labels for the contract effort levels, keyed off
 *  `EffortLevelSchema` so the level strings can't drift. The web picker surfaces a
 *  curated subset (`low`/`medium`/`high`) of the SDK superset
 *  (`low`/`medium`/`high`/`xhigh`/`max`); the higher levels exist on the contract
 *  but are intentionally not offered here this milestone. */
const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The effort levels the web picker surfaces, in display order. The contract-owned
 *  levels are referenced by value (so they can't drift in spelling); `none` is the
 *  web-only "disable extended thinking" sentinel appended at the end. */
const WEB_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/** The SDK reasoning-effort levels offered in the picker. `none` disables extended
 *  thinking. */
export const EFFORT_OPTIONS: EffortOption[] = [
  ...WEB_EFFORT_LEVELS.map((id) => ({ id, label: EFFORT_LABELS[id] })),
  { id: 'none', label: 'None' },
];
