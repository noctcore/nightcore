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
import type { PrReviewRun, ReviewLens, ReviewSeverity } from '@/lib/bridge';

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

/** Severity order, highest first (drives the RESULTS section headers + sorting). */
export const SEVERITY_ORDER: ReviewSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** A numeric rank for a severity (higher = more severe), for descending sorts. */
export function severityRankValue(s: ReviewSeverity): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);
}

interface SeverityMeta {
  label: string;
  /** Tailwind text tone for the badge. */
  tone: string;
  /** Tailwind bg/border tone for the badge chip. */
  chip: string;
}

/** Per-severity label + Tailwind tones for badges, chips, and section headers. */
export const SEVERITY_META: Record<ReviewSeverity, SeverityMeta> = {
  critical: {
    label: 'Critical',
    tone: 'text-destructive',
    chip: 'bg-destructive/[0.12] border-destructive/40',
  },
  high: {
    label: 'High',
    tone: 'text-warning',
    chip: 'bg-warning/[0.12] border-warning/40',
  },
  medium: {
    label: 'Medium',
    tone: 'text-primary',
    chip: 'bg-primary/[0.1] border-primary/40',
  },
  low: {
    label: 'Low',
    tone: 'text-muted-foreground',
    chip: 'bg-white/[0.04] border-border',
  },
  info: {
    label: 'Info',
    tone: 'text-muted-foreground',
    chip: 'bg-white/[0.04] border-border',
  },
};

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
