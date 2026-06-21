// Shared model + effort option sets (M4.7 §E/§F). These live in `@/lib` rather
// than a feature folder because both the board's per-task picker and the Settings
// model/effort defaults consume them — the single source of truth for the SDK
// model ids and effort levels sent on the wire.

/** A selectable model in the per-task picker / Settings default. The static
 *  known-Claude set this milestone (dynamic `listModels()` is deferred — §G). */
export interface ModelOption {
  /** The model id sent on the wire (mirrors the SDK / Rust `Task.model`). */
  id: string;
  label: string;
}

/** The known Claude model ids this milestone (contract §F). */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

/** A selectable reasoning-effort level — the SDK effort set (contract §E/§F). */
export interface EffortOption {
  /** The effort level sent on the wire (mirrors the SDK / Rust `Task.effort`). */
  id: string;
  label: string;
}

/** The SDK reasoning-effort levels. `none` disables extended thinking. */
export const EFFORT_OPTIONS: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'none', label: 'None' },
];
