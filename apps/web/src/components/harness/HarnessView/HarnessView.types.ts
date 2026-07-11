/** Prop + view-model types for the top-level HarnessView component. */
import type {
  BulkConvertBarProps,
  CategoryRunState,
  MenuItem,
  RunPhase,
  RunProgressCategory,
} from '@/components/ui';
import type { ConventionCategory, CoverageStatus } from '@/lib/bridge';
import type { ScanTarget } from '@/lib/source-ref';
import type { RunConfig } from '@/lib/useRunConfig';

import type { CategoryTab } from '../CategoryTabs';
import type {
  ConventionDriftVM,
  ConventionFindingVM,
  HarnessProposalVM,
  ProposedArtifactVM,
  RuleCoverageGapVM,
} from '../harness.types';
import type {
  HarnessMode,
  HarnessSection,
  HarnessSectionTab,
} from '../harness-sections';
import type { HarnessStream } from '../harness-stream';

/** Re-exported for the existing `./HarnessView.hooks` → `./HarnessView` import
 *  chain; the canonical home is `../harness-sections`. */
export type { HarnessSection } from '../harness-sections';

/** Props for the HarnessView shell: the active project's path and display name. */
export interface HarnessViewProps {
  /** The active project's absolute path (null when no project is active). */
  projectPath: string | null;
  /** The active project's display name. */
  projectName: string | null;
  /** Which destination this instance is: the PROPOSE half (`harden`), the ENFORCE
   *  half (`enforce`), or (undefined) the unified route showing every section. A
   *  pure view filter over the ONE harness run/store — see `../harness-sections`. */
  mode?: HarnessMode;
  /** Navigate to the board (used after convert-to-task). */
  onGotoBoard?: () => void;
  /** A board→scan provenance target: the run + item to load and open on mount
   *  (a task's `sourceRef` chip navigated here). `kind` picks the section —
   *  a convention finding or a task-shaped proposal. Consumed once. */
  preselect?: ScanTarget | null;
  /** Acknowledge the preselect so routing clears it (it never refires). */
  onPreselectConsumed?: () => void;
}

/** Everything the HarnessView shell renders. `hasProject === false` is the only
 *  early-return branch; every other field is meaningful in the project view. */
export interface HarnessViewModel {
  hasProject: boolean;
  projectName: string | null;
  stream: HarnessStream;
  isStarting: boolean;
  startError: string | null;
  /** Which lifecycle screen the shell renders: configure / running / results. */
  phase: RunPhase;
  /** Collapsed-config summary text (`⌖ Opus 4.8 · high · 8 lenses`). */
  summary: string;
  /** Return to CONFIGURE ("New run") with the last run's config pre-filled. */
  reconfigure: () => void;
  /** Lifted CONFIGURE run config (survives phase swaps, pre-fills on a new run).
   *  The shared shape Insight uses too. */
  config: RunConfig<ConventionCategory>;
  /** RUNNING-screen RunProgress inputs (view-agnostic shape). */
  progressCategories: RunProgressCategory[];
  categoryRunState: Record<string, CategoryRunState>;
  findingCounts: Record<string, number>;
  synthesizing: boolean;
  /** Progressive reveal: the finished lens peeked while others run, or `null`. */
  peekCategory: ConventionCategory | null;
  peekLabel: string | null;
  peekFindings: ConventionFindingVM[];
  openCategory: (key: string) => void;
  clearPeek: () => void;
  /** Run-history menu entries (newest first), each selecting that run. */
  runHistory: MenuItem[];
  /** Whether to surface the history affordance (≥1 persisted run). */
  hasHistory: boolean;
  /** Whether the profile banner should show its skeleton (scan running, no profile). */
  profileLoading: boolean;
  /** Whether the RepoProfile banner renders (hidden in the ENFORCE destination). */
  showProfileBanner: boolean;
  /** Which body section is active, and the toggle. */
  section: HarnessSection;
  setSection: (section: HarnessSection) => void;
  /** The mode-filtered, ordered section tabs (label + live badge count). Harden
   *  shows Proposals + Artifacts; Enforce shows Conventions + Policy; the unified
   *  route shows all four. */
  sectionTabs: HarnessSectionTab[];
  /** Convention-lens tabs + active tab. */
  tabs: CategoryTab[];
  activeTab: 'all' | ConventionCategory;
  setActiveTab: (key: 'all' | ConventionCategory) => void;
  gridFindings: ConventionFindingVM[];
  skeletonCount: number;
  emptyMessage: string;
  /** ENFORCE-lite coverage records for the displayed run (the Rule-Coverage-Gaps panel). */
  coverage: RuleCoverageGapVM[];
  /** Per-convention coverage status keyed by `fingerprint` — the ConventionGrid badge. */
  coverageByFingerprint: Record<string, CoverageStatus>;
  /** Drift-v1 (T15): the measured per-convention conformance from the last EnforceRun,
   *  joined to `coverage` by `conventionFingerprint` in the Rule-Coverage-Gaps panel. */
  drift: ConventionDriftVM[];
  /** Whether the Enforce destination surfaces coverage (badge + panel); false elsewhere. */
  showCoverage: boolean;
  /** Task-shaped proposals panel inputs (the convert-to-task units). */
  proposals: HarnessProposalVM[];
  proposalsLoading: boolean;
  proposalsEmptyMessage: string;
  /** File-level artifacts panel inputs. */
  artifacts: ProposedArtifactVM[];
  artifactsLoading: boolean;
  artifactsEmptyMessage: string;
  /** The finding open in the detail panel, or `null`. */
  selectedFinding: ConventionFindingVM | null;
  openFinding: (finding: ConventionFindingVM) => void;
  closeFinding: () => void;
  /** The proposal open in the detail panel, or `null`. */
  selectedProposal: HarnessProposalVM | null;
  openProposal: (proposal: HarnessProposalVM) => void;
  closeProposal: () => void;
  /** Convert-all bar slice for the ENFORCE conventions grid — spread into
   *  `<BulkConvertBar>` (count / progress / partial-failure / aria-live). */
  conventionsBulk: BulkConvertBarProps;
  /** Convert-all bar slice for the HARDEN proposals list — same shared idiom. */
  proposalsBulk: BulkConvertBarProps;
  /** The artifact open in the detail panel, or `null`. */
  selectedArtifact: ProposedArtifactVM | null;
  openArtifact: (artifact: ProposedArtifactVM) => void;
  closeArtifact: () => void;
  /** True while a finding/artifact action (dismiss/restore) is in flight. */
  pending: boolean;
  /** The artifact awaiting apply confirmation, or `null` (drives the dialog). */
  applyTarget: ProposedArtifactVM | null;
  /** True while the apply write is in flight. */
  applying: boolean;
  /** The error returned by the apply write, or `null`. */
  applyError: string | null;
  /** Launch a scan from the lifted CONFIGURE config. */
  onScan: () => void;
  onCancel: () => void;
  onConvertFinding: (findingId: string) => void;
  onDismissFinding: (findingId: string) => void;
  onRestoreFinding: (findingId: string) => void;
  /** Task-shaped proposal lifecycle actions. */
  onConvertProposal: (proposalId: string) => void;
  /** Open the bundle-apply confirmation for an `apply-artifacts` proposal. */
  onApplyProposal: (proposalId: string) => void;
  onDismissProposal: (proposalId: string) => void;
  onRestoreProposal: (proposalId: string) => void;
  /** The proposal awaiting bundle-apply confirmation, or `null` (drives the dialog). */
  applyProposalTarget: HarnessProposalVM | null;
  /** The repo-relative paths the bundle-apply would write (shown in the dialog). */
  applyProposalPaths: string[];
  /** Confirm the bundle apply (writes every referenced artifact to disk). */
  confirmApplyProposal: () => void;
  /** Dismiss the bundle-apply confirmation. */
  cancelApplyProposal: () => void;
  /** Navigate to the board (after convert-to-task / for a converted finding). */
  onGotoBoard?: () => void;
  onDismissArtifact: (artifactId: string) => void;
  onRestoreArtifact: (artifactId: string) => void;
  /** Open the apply confirmation for an artifact. */
  requestApply: (artifactId: string) => void;
  /** Confirm the apply (writes to disk). */
  confirmApply: () => void;
  /** Dismiss the apply confirmation. */
  cancelApply: () => void;
  /** The applied artifact awaiting arm confirmation, or `null` (drives the arm dialog). */
  armTarget: ProposedArtifactVM | null;
  /** The command that arming will write to the manifest (shown verbatim — the gate). */
  armCommand: string;
  /** Open the arm confirmation for an applied artifact. */
  requestArm: (artifactId: string) => void;
  /** Confirm arming (writes the check into `.nightcore/harness.json`). */
  confirmArm: () => void;
  /** Dismiss the arm confirmation. */
  cancelArm: () => void;
}
