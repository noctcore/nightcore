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
  DeepScanConfig,
  FindingCategory,
  FindingEffort,
} from '@/lib/bridge';

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

/** Label + hint for the Standard/Deep 2-chip radio (issue #294), keyed by the
 *  `deep` boolean as a string so it fits the same shape `SCOPE_META` uses. */
export const DEEP_MODE_META: Record<'standard' | 'deep', { label: string; hint: string }> = {
  standard: { label: 'Standard', hint: 'One pass per category' },
  deep: {
    label: 'Deep',
    hint: 'Multiple rounds per category until convergence — can run long',
  },
};

/** Deep mode's explicit per-run parameters (issue #294). MUST be sent with every
 *  field present — the generated Rust `DeepScanConfig` fields default to `0` on
 *  deserialize (not these zod schema defaults), so an empty `{}` would silently
 *  zero the round count / cap and produce a 0-round scan. Mirrors
 *  `DeepScanConfigSchema`'s zod defaults (15 rounds, 2-round convergence, 20
 *  findings/round). */
export const DEFAULT_DEEP_SCAN_CONFIG: DeepScanConfig = {
  maxRoundsPerCategory: 15,
  convergenceEmptyRounds: 2,
  maxFindingsPerRound: 20,
};


