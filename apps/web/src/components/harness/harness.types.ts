import type {
  ArtifactKind,
  ArtifactWriteMode,
  ConventionCategory,
  ConventionKind,
  FindingSeverity,
  HarnessProposalKind,
  RepoPackage,
  WorkspaceTool,
} from '@/lib/bridge';

/** Convention-finding lifecycle, narrowed from the persisted `string`. */
export type FindingStatus = 'open' | 'dismissed' | 'converted';

/** Proposed-artifact lifecycle, narrowed from the persisted `string`. */
export type ArtifactStatus = 'proposed' | 'applied' | 'dismissed';

/** Task-shaped-proposal lifecycle, narrowed from the persisted `string`. Mirrors the
 *  convention-finding lifecycle (a proposal converts to a board task). */
export type ProposalStatus = 'proposed' | 'dismissed' | 'converted';

/** A convention finding as the view renders it: the unified, union-typed shape
 *  both the live wire `ConventionFinding` (contract) and the persisted
 *  `StoredConventionFinding` (ts-rs) normalize into. */
export interface ConventionFindingVM {
  id: string;
  category: ConventionCategory;
  kind: ConventionKind;
  severity: FindingSeverity;
  title: string;
  description: string;
  rationale: string | null;
  /** Repo-relative file anchors the convention is grounded in (a convention is a
   *  repo-wide pattern, so this is a LIST, not a single location). */
  evidence: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  }[];
  suggestion: string | null;
  tags: string[];
  confidence: number | null;
  fingerprint: string;
  status: FindingStatus;
  /** The board task this finding was converted into, if any (`converted` status). */
  linkedTaskId: string | null;
}

/** A proposed harness artifact as the view renders it: the unified shape both the
 *  live wire `ProposedArtifact` (contract) and the persisted `StoredProposedArtifact`
 *  (ts-rs) normalize into. */
export interface ProposedArtifactVM {
  id: string;
  kind: ArtifactKind;
  /** Groups artifacts that ship together (e.g. `eslint-plugin`). */
  group: string | null;
  groupTitle: string | null;
  title: string;
  description: string;
  rationale: string | null;
  /** Repo-relative destination path. */
  targetPath: string;
  writeMode: ArtifactWriteMode;
  /** Full file content (for `create`) or the managed-section body (`merge-section`). */
  content: string;
  language: string | null;
  sourceFindings: string[];
  dependsOn: string[];
  confidence: number | null;
  fingerprint: string;
  status: ArtifactStatus;
  /** The repo-relative path the artifact was written to, once `applied`. */
  appliedPath: string | null;
  appliedAt: number | null;
}

/** A suggested Structure-Lock check carried on a proposal, as the view renders it. */
export interface HarnessCheckVM {
  name: string;
  kind: string;
  command: string;
}

/** A task-shaped harness proposal as the view renders it: the unified shape both the
 *  live wire `HarnessProposal` (contract) and the persisted `StoredHarnessProposal`
 *  (ts-rs) normalize into. The unit the user converts into a board task. */
export interface HarnessProposalVM {
  id: string;
  /** `apply-artifacts` (bundle → apply.rs) | `agent-task` (worktree Build task). */
  kind: HarnessProposalKind;
  title: string;
  description: string;
  rationale: string | null;
  /** `apply-artifacts`: the artifact ids this proposal bundles. */
  artifactIds: string[];
  /** `agent-task`: the Build-task prompt. */
  prompt: string | null;
  /** `agent-task`: the machine-checkable done-command (→ the task's `verify_command`). */
  verifyCommand: string | null;
  /** The gauntlet check this proposal suggests arming once its work lands. */
  harnessCheck: HarnessCheckVM | null;
  confidence: number | null;
  fingerprint: string;
  status: ProposalStatus;
  /** The board task this proposal was converted into, if any (`converted` status). */
  linkedTaskId: string | null;
}

/** The deterministically-detected repo profile as the ProfileBanner renders it. */
export interface RepoProfileVM {
  isMonorepo: boolean;
  workspaceTool: WorkspaceTool;
  packages: RepoPackage[];
  languages: string[];
  frameworks: string[];
  hasEslintFlatConfig: boolean;
  hasLintMeta: boolean;
  hasAgentDocs: boolean;
  existingPlugins: string[];
}

/** A run-status drives the header chrome + whether controls are busy. */
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed';

/** A lens's progress within a scan. */
export type CategoryProgress = 'pending' | 'running' | 'done' | 'error';
