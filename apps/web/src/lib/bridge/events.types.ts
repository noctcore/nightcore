/**
 * The event payload types delivered over the web↔Rust bridge's `nc:*` `listen`
 * subscriptions. These are the AUTHORITATIVE web-local shapes: several narrow the
 * generated contract types (`NcEvent`) to a single channel's family, and a few
 * name web-local unions whose Rust source field is a free `string`.
 */
import type { NcEvent, Project, QuestionItem } from './types';

/** `nc:session` payload: a streamed engine event tagged with its task. */
export interface SessionEnvelope {
  taskId: string;
  event: NcEvent;
}

/** `nc:permission` payload: an interactive permission prompt for a running task.
 *  The input may contain paths/commands — render it, but the core never logs it. */
export interface PermissionPrompt {
  taskId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Optional SDK-provided choices the surface can offer (rarely present). */
  suggestions?: unknown;
}

/** `nc:question` payload: an interactive `AskUserQuestion` prompt for a running
 *  task. The questions/options carry model-authored text — render it, but the core
 *  never logs it. The surface answers via the `answer_question` command. */
export interface QuestionPrompt {
  taskId: string;
  requestId: string;
  /** SDK toolUseId of the originating call, when the dialog carried one. */
  toolUseId?: string;
  questions: QuestionItem[];
}

/** The `nc:project` event variant union. This is the AUTHORITATIVE type — every
 *  place that cares about project event kinds (the interface, the runtime guard,
 *  and any downstream switch) references THIS, not a hand-enumerated literal. When
 *  a new event variant is added to the Rust emitter, add it here first; the
 *  `satisfies` on `PROJECT_EVENT_TYPES` below will then force a compile error until
 *  the array is updated to match. */
export type ProjectEventType = 'created' | 'deleted' | 'activated' | 'renamed' | 'updated';

/** `nc:project` payload: a registry change plus the full registry snapshot.
 *  `renamed` carries the updated project (name changed; active pointer unchanged). */
export interface ProjectEnvelope {
  type: ProjectEventType;
  project: Project | null;
  projects: Project[];
}

/** The autonomous loop's run state. This is the AUTHORITATIVE type — the generated
 *  `LoopEnvelope.state` field is a plain `string` (Rust emits it as a free string),
 *  so this web-local union is the single source of truth for valid states. When the
 *  Rust coordinator adds a new state, add it here first; the `satisfies` on
 *  `LOOP_STATES` below will then force a compile error until the array is updated. */
export type LoopState = 'running' | 'drained' | 'paused';

/** The Insight analysis event family streamed over `nc:insight`, narrowed from
 *  the authoritative `NightcoreEvent` union. `analysis-category-round-completed`
 *  (issue #294) is DEEP-mode only: one round of a category's multi-round loop
 *  finished, carrying the cumulative grounded findings for that category so far.
 *  It replaces the classic per-category terminal event for a deep run — the engine
 *  never emits `analysis-category-completed` for a category running deep. */
export type AnalysisEvent = Extract<
  NcEvent,
  {
    type:
      | 'analysis-started'
      | 'analysis-category-started'
      | 'analysis-category-completed'
      | 'analysis-category-round-completed'
      | 'analysis-completed'
      | 'analysis-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:insight` when a finding
 *  is converted to a board task, so the open Insight view can update in place. */
export interface FindingConvertedEvent {
  type: 'finding-converted';
  runId: string;
  findingId: string;
  taskId: string;
}

/** Everything that arrives on the `nc:insight` channel. */
export type InsightEvent = AnalysisEvent | FindingConvertedEvent;

/** The PR Review event family streamed over `nc:pr-review`, narrowed from the
 *  authoritative `NightcoreEvent` union. Unlike Insight — whose `finding-converted`
 *  is a non-schema notice shape-checked in place — the convert acknowledgement
 *  `pr-review-finding-converted` is itself a `NightcoreEvent`, so the whole channel
 *  narrows as one validated family. */
export type PrReviewEvent = Extract<
  NcEvent,
  {
    type:
      | 'pr-review-started'
      | 'pr-review-lens-started'
      | 'pr-review-lens-completed'
      | 'pr-review-round-completed'
      | 'pr-review-completed'
      | 'pr-review-failed'
      | 'pr-review-finding-converted';
  }
>;

/** The Issue Triage event family streamed over `nc:issue-triage`, narrowed from the
 *  authoritative `NightcoreEvent` union. Like PR Review — and unlike Insight — the
 *  convert acknowledgement (`issue-validation-converted`) is itself a `NightcoreEvent`,
 *  so the whole channel narrows as one validated family with no separate notice
 *  branch. This is ONE read-only session per run, so there are no per-pass events. */
export type IssueTriageEvent = Extract<
  NcEvent,
  {
    type:
      | 'issue-validation-started'
      | 'issue-validation-progress'
      | 'issue-validation-completed'
      | 'issue-validation-failed'
      | 'issue-validation-converted';
  }
>;

/** The KNOWN pr-fix lifecycle statuses (running → committing → awaiting_push →
 *  pushed, or failed) — the generated `PrFixState.status` field is a plain
 *  `string` (Rust emits it as a free string), so this web-local union names the
 *  states the UI renders explicitly. Consumers switch on these members and fall
 *  through on anything else (the FixRunCard pattern): the narrower below
 *  deliberately accepts ANY string status, matching the un-narrowed
 *  `list_pr_fixes` path, so a newer backend status is never dropped on the
 *  event path while the list path lets it through. */
export type PrFixStatus =
  | 'running'
  | 'committing'
  | 'awaiting_push'
  | 'pushed'
  | 'failed';

/** The Scorecard event family streamed over `nc:scorecard`, narrowed from the
 *  authoritative `NightcoreEvent` union. */
export type ScorecardWireEvent = Extract<
  NcEvent,
  {
    type:
      | 'scorecard-started'
      | 'scorecard-dimension-started'
      | 'scorecard-dimension-completed'
      | 'scorecard-completed'
      | 'scorecard-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:scorecard` when a reading
 *  is hardened into a board task, so the open Scorecard view can update in place. */
export interface ReadingConvertedEvent {
  type: 'reading-converted';
  runId: string;
  readingId: string;
  taskId: string;
}

/** Everything that arrives on the `nc:scorecard` channel. */
export type ScorecardEvent = ScorecardWireEvent | ReadingConvertedEvent;

/** The Harness scan event family streamed over `nc:harness`, narrowed from the
 *  authoritative `NightcoreEvent` union. Mirrors `AnalysisEvent`, with the two
 *  extra hops Harness adds (`harness-profile-ready`, `harness-proposals-ready`). */
export type HarnessScanEvent = Extract<
  NcEvent,
  {
    type:
      | 'harness-scan-started'
      | 'harness-profile-ready'
      | 'harness-category-started'
      | 'harness-category-completed'
      | 'harness-category-round-completed'
      | 'harness-synthesis-started'
      | 'harness-proposals-ready'
      | 'harness-scan-completed'
      | 'harness-scan-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when an
 *  artifact is written to disk, so the open Harness view can mark it applied in
 *  place. */
export interface ArtifactAppliedEvent {
  type: 'artifact-applied';
  runId: string;
  artifactId: string;
  /** The repo-relative path the artifact was written to. */
  path: string;
}

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when a convention
 *  finding is converted to a board task, so the open Harness view can update in place.
 *  The Harness twin of {@link FindingConvertedEvent}. */
export interface HarnessFindingConvertedEvent {
  type: 'finding-converted';
  runId: string;
  findingId: string;
  taskId: string;
}

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when a
 *  Structure-Lock check is armed into `.nightcore/harness.json`, so the open Harness
 *  view can confirm the gauntlet is now wired. */
export interface HarnessCheckArmedEvent {
  type: 'check-armed';
  runId: string;
  /** The check name written to the manifest. */
  name: string;
  /** The check kind (`lint-plugin` | `dependency-cruiser` | `coverage-threshold`). */
  kind: string;
}

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when a task-shaped
 *  proposal is converted to a board task, so the open Harness view can update in place.
 *  The proposal twin of {@link HarnessFindingConvertedEvent}. */
export interface HarnessProposalConvertedEvent {
  type: 'proposal-converted';
  runId: string;
  proposalId: string;
  taskId: string;
}

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when an
 *  `apply-artifacts` proposal is applied as a bundle (all its artifacts written to disk),
 *  so the open Harness view can mark the proposal applied in place. */
export interface HarnessProposalAppliedEvent {
  type: 'proposal-applied';
  runId: string;
  proposalId: string;
  /** How many artifacts the bundle wrote. */
  count: number;
}

/** Everything that arrives on the `nc:harness` channel. */
export type HarnessEvent =
  | HarnessScanEvent
  | ArtifactAppliedEvent
  | HarnessFindingConvertedEvent
  | HarnessProposalConvertedEvent
  | HarnessProposalAppliedEvent
  | HarnessCheckArmedEvent;

/** The transient progress payload the Rust core emits on the raw `nc:issue-map`
 *  channel while `export_issue_map` mints the map (one per sub-issue created +
 *  attached). Purely cosmetic — the terminal `IssueMapResult` is the source of
 *  truth — so it is deliberately NOT in the `CHANNELS` registry (no persistence,
 *  no new store, §4.1). The dialog consumes it to show "Creating… k/N". */
export interface IssueMapProgress {
  type: 'progress';
  /** The run being exported (the dialog ignores foreign runs). */
  runId: string;
  /** Sub-issues created + attached so far. */
  created: number;
  /** Total sub-issues the export will create (= the finding count). */
  total: number;
}
