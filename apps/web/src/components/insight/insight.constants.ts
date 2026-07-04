/** Static display metadata for the Insight surface: category/severity/effort/scope
 *  labels and glyphs, plus the helpers that order and project these enums. */
import type { ComponentType } from 'react';

import {
  BookIcon,
  BugIcon,
  ChecksIcon,
  DepsIcon,
  DesignIcon,
  LayersIcon,
  PerfIcon,
  RefactorIcon,
  VerifiedIcon,
} from '@/components/ui';
import type {
  AnalysisScope,
  FindingCategory,
  FindingEffort,
  InsightRun,
} from '@/lib/bridge';

import type { RunStatus } from './insight.types';

/** Every category, in display order. */
export const ALL_CATEGORIES: FindingCategory[] = [
  'architecture',
  'bugs',
  'refactor',
  'performance',
  'security',
  'tests',
  'docs',
  'ui-ux',
  'dependencies',
];

interface CategoryMeta {
  label: string;
  icon: ComponentType<{ size?: number }>;
}

/** Per-category label + glyph for tabs and cards. */
export const CATEGORY_META: Record<FindingCategory, CategoryMeta> = {
  architecture: { label: 'Architecture', icon: LayersIcon },
  bugs: { label: 'Bugs', icon: BugIcon },
  refactor: { label: 'Refactor', icon: RefactorIcon },
  performance: { label: 'Performance', icon: PerfIcon },
  security: { label: 'Security', icon: VerifiedIcon },
  tests: { label: 'Tests', icon: ChecksIcon },
  docs: { label: 'Docs', icon: BookIcon },
  'ui-ux': { label: 'UI / UX', icon: DesignIcon },
  dependencies: { label: 'Dependencies', icon: DepsIcon },
};

/** The severity scale (order, ranking, badge palette) is shared across every
 *  grounded-finding surface — re-exported from `lib/` so it can't drift per
 *  feature. See {@link ../../lib/severity}. */
export { SEVERITY_META, SEVERITY_ORDER, severityRankValue } from '@/lib/severity';

/** Per-effort display label. */
export const EFFORT_META: Record<FindingEffort, { label: string }> = {
  trivial: { label: 'Trivial' },
  small: { label: 'Small' },
  medium: { label: 'Medium' },
  large: { label: 'Large' },
};

/** Per-scope label + hint for the scope selector. */
export const SCOPE_META: Record<AnalysisScope, { label: string; hint: string }> = {
  repo: { label: 'Whole repo', hint: 'Analyze the entire codebase' },
  diff: { label: 'Changes', hint: 'Only files changed since the last commit' },
};

/** Map a persisted run's status string to the view's union. */
export function runStatusOf(run: InsightRun | null): RunStatus {
  if (run === null) return 'idle';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}
