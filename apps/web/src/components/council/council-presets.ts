/**
 * Council preset-picker metadata (issue #349 / GOV-2). The concrete preset VALUES
 * live engine-side (`packages/engine/src/debate/preset-registry.ts`) — the sidecar
 * tier the board can't import — so the picker's human-facing copy is carried here,
 * mirroring each registered preset's label + success criterion. Keyed by the
 * cross-tier `CouncilPresetId`, so adding a preset id fails to type-check until it
 * has a card (the same total-map parity guard the registry uses).
 */
import type { CouncilPresetId } from '@/lib/bridge';

/** One selectable preset card in the start panel. */
export interface CouncilPresetCard {
  /** The cross-tier preset id passed through to `start_council`. */
  id: CouncilPresetId;
  /** Short picker title. */
  title: string;
  /** One-line description of what the preset debates + how it decides. */
  description: string;
}

/** Title + one-line description per preset, mirroring the engine preset registry. */
const PRESET_META: Record<CouncilPresetId, { title: string; description: string }> = {
  research: {
    title: 'Research',
    description:
      '≤4 seats, ≥2 distinct models · Frame → Propose (blind) → Debate → Converge (you judge). A synthesized recommendation with cited tradeoffs.',
  },
  'ui-bug': {
    title: 'UI bug',
    description:
      'Reproduce-first: the council pins a RED repro, the single-writer Build turns it GREEN, and the repro gate — not the debate — decides success.',
  },
  coding: {
    title: 'Coding',
    description:
      'Debate the implementation plan only, never keystrokes. The single-writer Build executes it and a build/test gate decides success.',
  },
};

/** The presets offered in the start panel, in display order. Ordered explicitly so
 *  a new preset id must be placed deliberately rather than by object-key accident. */
export const COUNCIL_PRESET_CARDS: readonly CouncilPresetCard[] = (
  ['research', 'ui-bug', 'coding'] as const
).map((id) => ({ id, ...PRESET_META[id] }));

/** The default selection — P1's research council. */
export const DEFAULT_COUNCIL_PRESET: CouncilPresetId = 'research';
