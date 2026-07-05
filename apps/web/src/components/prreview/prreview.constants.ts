/** Static display metadata for the PR Review surface: severity / lens / verdict
 *  labels and glyphs, plus the helpers that order and project these enums. Mirrors
 *  the Insight constants (severity shares the same `info…critical` value set) but
 *  lives here so the two features stay decoupled (no-cross-feature-imports). */
import type { ComponentType } from 'react';

import {
  AlertIcon,
  BugIcon,
  CheckIcon,
  ChecksIcon,
  LayersIcon,
  QuestionIcon,
  TagIcon,
  VerifiedIcon,
} from '@/components/ui';
import type { PrReviewRun, ReviewLens } from '@/lib/bridge';

import type { ReviewVerdict, RunStatus } from './prreview.types';

/** Every lens, in display order (matches the contract's `ReviewLensSchema`). */
export const ALL_LENSES: ReviewLens[] = [
  'security',
  'logic',
  'structure',
  'tests',
  'contracts',
];

interface LensMeta {
  label: string;
  icon: ComponentType<{ size?: number }>;
}

/** Per-lens label + glyph for the chip grid, progress rows, and cards. */
export const LENS_META: Record<ReviewLens, LensMeta> = {
  security: { label: 'Security', icon: VerifiedIcon },
  logic: { label: 'Logic', icon: BugIcon },
  structure: { label: 'Structure', icon: LayersIcon },
  tests: { label: 'Tests', icon: ChecksIcon },
  contracts: { label: 'Contracts', icon: TagIcon },
};

/** The severity scale (order, ranking, badge palette) is shared across every
 *  grounded-finding surface — re-exported from `lib/` so it can't drift per
 *  feature (`no-cross-feature-imports` forbids reaching into a sibling feature,
 *  so `lib/` is the one import-legal shared home). See {@link ../../lib/severity}. */
export { SEVERITY_META, SEVERITY_ORDER, severityRankValue } from '@/lib/severity';

interface VerdictMeta {
  label: string;
  /** Tailwind text tone for the toolbar button glyph. */
  tone: string;
  icon: ComponentType<{ size?: number }>;
  /** Whether the confirm gate renders the destructive (red) variant. */
  destructive: boolean;
  /** The confirm-dialog title + confirm-button label for this verdict. */
  confirmTitle: string;
  confirmLabel: string;
}

/** Per-verdict label / tone / glyph and the human-gate confirm chrome. Only
 *  Request changes is destructive. */
export const VERDICT_META: Record<ReviewVerdict, VerdictMeta> = {
  approve: {
    label: 'Approve',
    tone: 'text-success',
    icon: CheckIcon,
    destructive: false,
    confirmTitle: 'Approve this pull request?',
    confirmLabel: 'Post approval',
  },
  'request-changes': {
    label: 'Request changes',
    tone: 'text-destructive',
    icon: AlertIcon,
    destructive: true,
    confirmTitle: 'Request changes on this pull request?',
    confirmLabel: 'Request changes',
  },
  comment: {
    label: 'Comment',
    tone: 'text-muted-foreground',
    icon: QuestionIcon,
    destructive: false,
    confirmTitle: 'Post a review comment?',
    confirmLabel: 'Post comment',
  },
};

/** Map a persisted run's status string to the view's union. */
export function runStatusOf(run: PrReviewRun | null): RunStatus {
  if (run === null) return 'idle';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}

/** The synthesis pass's overall merge recommendation, in the wire `MergeVerdict`
 *  form (distinct from the POST {@link ReviewVerdict} — this is the AI's read on
 *  the PR, not a GitHub review event). */
export type MergeVerdict = 'ready' | 'merge_with_changes' | 'needs_revision' | 'blocked';

/** Display meta for one merge verdict: the badge label + its semantic chip
 *  classes (border + bg + text tokens). */
export interface MergeVerdictMeta {
  label: string;
  badgeClass: string;
}

/** Resolve a run's `verdict` string to its badge meta, or `null` for an
 *  unknown/absent value (the surface renders nothing — the same fail-open
 *  posture the wire field carries). `ready` reads success, the two
 *  merge-with-caveats verdicts warn, `blocked` is destructive. */
export function mergeVerdictMeta(verdict: string): MergeVerdictMeta | null {
  switch (verdict) {
    case 'ready':
      return {
        label: 'Ready to merge',
        badgeClass: 'border-success/40 bg-success/[0.12] text-success',
      };
    case 'merge_with_changes':
      return {
        label: 'Merge with changes',
        badgeClass: 'border-warning/40 bg-warning/[0.12] text-warning',
      };
    case 'needs_revision':
      return {
        label: 'Needs revision',
        badgeClass: 'border-warning/40 bg-warning/[0.12] text-warning',
      };
    case 'blocked':
      return {
        label: 'Blocked',
        badgeClass: 'border-destructive/40 bg-destructive/[0.12] text-destructive',
      };
    default:
      return null;
  }
}
