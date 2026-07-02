/** Static Scorecard lookup tables: the dimension list + per-dimension and
 *  per-grade display metadata, plus grade-ranking and run-status helpers. */
import type { ComponentType } from 'react';

import {
  AlertIcon,
  BoltIcon,
  BookIcon,
  ChecksIcon,
  DepsIcon,
  DesignIcon,
  LayersIcon,
  PerfIcon,
  ResearchIcon,
  VerifiedIcon,
} from '@/components/ui';
import type {
  ScorecardDimension,
  ScorecardGrade,
  ScorecardRun,
} from '@/lib/bridge';

import type { RunStatus } from './scorecard.types';

/** Every dimension, in display order. */
export const ALL_DIMENSIONS: ScorecardDimension[] = [
  'architecture',
  'tests',
  'security',
  'error-handling',
  'observability',
  'dependencies',
  'performance',
  'types',
  'a11y',
  'docs-ci',
];

interface DimensionMeta {
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

/** Per-dimension label + glyph for the grid rows and detail header. */
export const DIMENSION_META: Record<ScorecardDimension, DimensionMeta> = {
  architecture: { label: 'Architecture', icon: LayersIcon },
  tests: { label: 'Tests', icon: ChecksIcon },
  security: { label: 'Security', icon: VerifiedIcon },
  'error-handling': { label: 'Error Handling', icon: AlertIcon },
  observability: { label: 'Observability', icon: ResearchIcon },
  dependencies: { label: 'Dependencies', icon: DepsIcon },
  performance: { label: 'Performance', icon: PerfIcon },
  types: { label: 'Type Safety', icon: BoltIcon },
  a11y: { label: 'Accessibility', icon: DesignIcon },
  'docs-ci': { label: 'Docs & CI', icon: BookIcon },
};

/** Grade order, best first (for sorting the grid worst-grade first via reversal). */
export const GRADE_ORDER: ScorecardGrade[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Lower is better-graded; F (worst) ranks highest so the grid can surface the
 *  weakest dimensions first. */
export function gradeRankValue(g: ScorecardGrade): number {
  return GRADE_ORDER.indexOf(g);
}

interface GradeMeta {
  label: string;
  /** Tailwind text tone for the letter. */
  tone: string;
  /** Tailwind bg/border tone for the grade chip. */
  chip: string;
}

/** A–F → tone. A/B read as healthy (success/primary), C neutral, D/E/F escalate
 *  toward destructive so the weakest dimensions are visually loud. */
export const GRADE_META: Record<ScorecardGrade, GradeMeta> = {
  A: { label: 'A', tone: 'text-success', chip: 'bg-success/[0.12] border-success/40' },
  B: { label: 'B', tone: 'text-success', chip: 'bg-success/[0.1] border-success/30' },
  C: { label: 'C', tone: 'text-primary', chip: 'bg-primary/[0.1] border-primary/40' },
  D: { label: 'D', tone: 'text-warning', chip: 'bg-warning/[0.12] border-warning/40' },
  E: {
    label: 'E',
    tone: 'text-warning',
    chip: 'bg-warning/[0.16] border-warning/50',
  },
  F: {
    label: 'F',
    tone: 'text-destructive',
    chip: 'bg-destructive/[0.12] border-destructive/40',
  },
};

/** Map a persisted run's status string to the view's union. */
export function runStatusOf(run: ScorecardRun | null): RunStatus {
  if (run === null) return 'idle';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}
