import type { ComponentType } from 'react';

import {
  AgentsIcon,
  BookIcon,
  ChecksIcon,
  DecomposeIcon,
  FolderIcon,
  LayersIcon,
  RefactorIcon,
  TagIcon,
} from '@/components/ui';
import type {
  ArtifactKind,
  ConventionCategory,
  ConventionKind,
  FindingSeverity,
  HarnessProposalKind,
  HarnessRun,
} from '@/lib/bridge';

import type { RunStatus } from './harness.types';

/** Every convention lens, in display order. */
export const ALL_CATEGORIES: ConventionCategory[] = [
  'architecture',
  'folder-structure',
  'naming',
  'imports-boundaries',
  'design-decisions',
  'tooling-lint',
  'testing',
  'agent-context',
];

interface CategoryMeta {
  label: string;
  /** Accepts `className` so it can be tinted at the call site (e.g. RunProgress
   *  rows render it `text-muted-foreground`). */
  icon: ComponentType<{ size?: number; className?: string }>;
}

/** Per-lens label + glyph for tabs and cards. */
export const CATEGORY_META: Record<ConventionCategory, CategoryMeta> = {
  architecture: { label: 'Architecture', icon: LayersIcon },
  'folder-structure': { label: 'Folder Structure', icon: FolderIcon },
  naming: { label: 'Naming', icon: TagIcon },
  'imports-boundaries': { label: 'Imports & Boundaries', icon: DecomposeIcon },
  'design-decisions': { label: 'Design Decisions', icon: BookIcon },
  'tooling-lint': { label: 'Tooling & Lint', icon: RefactorIcon },
  testing: { label: 'Testing', icon: ChecksIcon },
  'agent-context': { label: 'Agent Context', icon: AgentsIcon },
};

interface KindMeta {
  label: string;
  /** Tailwind text tone for the badge. */
  tone: string;
  /** Tailwind bg/border tone for the badge chip. */
  chip: string;
}

/** Whether a finding records an existing convention (codify + enforce it) or a
 *  gap against best practice (propose adopting it). */
export const KIND_META: Record<ConventionKind, KindMeta> = {
  convention: {
    label: 'Convention',
    tone: 'text-primary',
    chip: 'bg-primary/[0.1] border-primary/40',
  },
  gap: {
    label: 'Gap',
    tone: 'text-warning',
    chip: 'bg-warning/[0.12] border-warning/40',
  },
};

/** Severity order, highest first (for sorting + the "All" tab). Kept local rather
 *  than imported from the Insight feature: `no-cross-feature-imports` forbids
 *  reaching into a sibling feature's runtime, so the unified severity scale is
 *  re-declared here (it collapses to the same contract enum either way). */
export const SEVERITY_ORDER: FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export function severityRankValue(s: FindingSeverity): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);
}

interface SeverityMeta {
  label: string;
  /** Tailwind text tone for the badge. */
  tone: string;
  /** Tailwind bg/border tone for the badge chip. */
  chip: string;
}

export const SEVERITY_META: Record<FindingSeverity, SeverityMeta> = {
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

/** Per-artifact-kind label for the proposal list + detail panel. */
export const ARTIFACT_KIND_META: Record<ArtifactKind, { label: string }> = {
  'lint-meta-rule': { label: 'lint-meta rule' },
  'eslint-rule': { label: 'ESLint rule' },
  'eslint-plugin-file': { label: 'ESLint plugin file' },
  'eslint-config': { label: 'ESLint config' },
  'agent-contract': { label: 'Agent contract' },
  'custom-lint-plugin': { label: 'Custom lint plugin' },
  'tool-config': { label: 'Tool config' },
};

/** eslint-runnable artifact kinds. Arming one wires the project's Structure-Lock
 *  gauntlet to actually execute the generated plugin — otherwise an applied plugin sits
 *  inert (never loaded by the user's own eslint config). Docs and lint-meta rules are
 *  not eslint-runnable, so they're excluded. */
const ESLINT_ARMABLE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'eslint-rule',
  'eslint-plugin-file',
  'eslint-config',
  'custom-lint-plugin',
]);

/** Whether an artifact's kind can be armed as an ESLint gauntlet check (module #2 /
 *  inert-plugin fix). Combine with an `applied` status check at the call site. */
export function isEslintArmableKind(kind: ArtifactKind): boolean {
  return ESLINT_ARMABLE_KINDS.has(kind);
}

/** Per-proposal-kind label + one-line hint for the task-proposal list. `apply-artifacts`
 *  bundles safe file writes onto the hardened apply.rs path; `agent-task` becomes a
 *  worktree Build task an agent performs and a human reviews as a diff. */
export const PROPOSAL_KIND_META: Record<
  HarnessProposalKind,
  { label: string; hint: string }
> = {
  'apply-artifacts': {
    label: 'Apply artifacts',
    hint: 'writes the bundled files to disk',
  },
  'agent-task': {
    label: 'Agent task',
    hint: 'a worktree Build task, reviewed as a diff',
  },
};

/** How `apply` writes the artifact, as the confirm dialog states it. */
export const WRITE_MODE_META: Record<string, { label: string; hint: string }> = {
  create: {
    label: 'create',
    hint: 'new file — refuses to overwrite an existing one',
  },
  'merge-section': {
    label: 'merge-section',
    hint: 'managed block — inserted or replaced, creating the file if absent',
  },
};

/** Map a persisted run's status string to the view's union. */
export function runStatusOf(run: HarnessRun | null): RunStatus {
  if (run === null) return 'idle';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}
