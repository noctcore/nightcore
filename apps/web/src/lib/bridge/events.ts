/**
 * The web↔Rust bridge's EVENT surface: every `nc:*` `listen` subscription the board
 * uses, the event payload types they deliver, and the defensive narrowers that
 * validate each payload against the authoritative `@nightcore/contracts` schemas
 * before dispatch. Outside the Tauri webview every subscription is a silent no-op.
 */
import { type EventCallback, listen, type UnlistenFn } from '@tauri-apps/api/event';

import { CHANNELS, NightcoreEventSchema, QuestionItemSchema } from '@nightcore/contracts';

import { isTauri } from './internal';
import type {
  LoopEnvelope,
  NcEvent,
  PrFixState,
  Project,
  QuestionItem,
  Task,
} from './types';

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

/** Runtime membership array for `ProjectEventType`. Must stay exhaustive: the
 *  `satisfies` clause makes adding a variant to `ProjectEventType` above without
 *  adding it here a compile error. The guard uses this array directly — no
 *  hand-enumerated strings at the call site. */
const PROJECT_EVENT_TYPES = ['created', 'deleted', 'activated', 'renamed', 'updated'] as const satisfies readonly ProjectEventType[];

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

/** Runtime membership array for `LoopState`. Must stay exhaustive: the `satisfies`
 *  clause makes adding a state to `LoopState` above without adding it here a compile
 *  error. The guard uses this array directly — no hand-enumerated strings at the
 *  call site. */
const LOOP_STATES = ['running', 'drained', 'paused'] as const satisfies readonly LoopState[];

// --- Events ---------------------------------------------------------------

/** True when `value` is a non-null object exposing every key in `keys`. The
 *  shared spine of the defensive narrowers below — narrows `value` to a string
 *  record so each guard can then check the field *types* it actually reads. */
function hasKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return keys.every((k) => k in value);
}

/** Narrow an unknown payload to a `Task` defensively. INTENTIONALLY PARTIAL: only
 *  validates the fields the board reducer + optimistic-move reconciliation actually
 *  read (`id`, `status`, `createdAt`/`updatedAt`). The full shape is the generated
 *  `Task` type (`../generated/Task.ts`) — add checks here if the reducer starts
 *  consuming new fields that could be missing or mis-typed. */
function isTask(value: unknown): value is Task {
  if (!hasKeys(value, ['id', 'status', 'createdAt', 'updatedAt'])) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

/** Parse an unknown `nc:session` payload into a validated `SessionEnvelope`, or
 *  `null` when the shape or the inner event fails the authoritative contract.
 *  The inner `event` is validated against `NightcoreEventSchema`: a
 *  malformed/future event is dropped rather than fed to `foldSession`. */
function parseSessionEnvelope(value: unknown): SessionEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== 'string') return null;
  const parsed = NightcoreEventSchema.safeParse(v.event);
  if (!parsed.success) return null;
  return { taskId: v.taskId, event: parsed.data };
}

/** `listen`, but the returned unlisten can NEVER throw or reject — every `nc:*`
 *  subscription routes through this. React `<StrictMode>` (dev) mounts effects
 *  twice (mount → unmount → mount), so a hook's fire-and-forget
 *  `void unlisten.then((fn) => fn())` cleanup can call Tauri's unlisten against an
 *  event registration whose internal `listeners[eventId]` entry is already gone —
 *  Tauri's unlisten isn't idempotent and throws
 *  `undefined is not an object (listeners[eventId].handlerId)`. That throw lands as
 *  an unhandled promise rejection, which `useGlobalErrorToast` then surfaces as a
 *  stray "Unexpected error" toast. Swallowing it here keeps teardown idempotent and
 *  silent (and a failed registration resolves to a no-op unlisten, so the cleanup
 *  promise never rejects either). */
async function safeListen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  try {
    const unlisten = await listen<T>(event, handler);
    return () => {
      try {
        unlisten();
      } catch {
        // Already torn down (StrictMode double-cleanup / rapid remount) — idempotent.
      }
    };
  } catch {
    // Registration failed (e.g. the Tauri runtime isn't ready) — nothing to undo.
    return () => {};
  }
}

/** The shared `nc:*` subscription skeleton: no-op outside Tauri, otherwise
 *  `safeListen` on `channel` and dispatch only payloads that `narrow` accepts
 *  (returns the typed value, or `null` to drop). Collapses the nine per-channel
 *  subscribers into a single shape. */
function subscribeChannel<T>(
  channel: string,
  narrow: (value: unknown) => T | null,
  handler: (value: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return safeListen<unknown>(channel, (event) => {
    const value = narrow(event.payload);
    if (value !== null) handler(value);
  });
}

/** Subscribe to `nc:task` board upserts. Returns an unlisten function. */
export async function onTaskEvent(
  handler: (task: Task) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.task, (v) => (isTask(v) ? v : null), handler);
}

/** Subscribe to `nc:session` streamed events. Returns an unlisten function. */
export async function onSessionEvent(
  handler: (envelope: SessionEnvelope) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.session, parseSessionEnvelope, handler);
}

/** Narrow an unknown payload to a `ProjectEnvelope` defensively. The handler reads
 *  `type`, the full `projects` snapshot, and `project` (for activated/renamed), so
 *  all three are checked: a valid `type`, an array `projects`, and `project` being
 *  an object-or-null. `PROJECT_EVENT_TYPES` is the single source of truth for the
 *  membership check — no hand-enumerated string literals here. */
function isProjectEnvelope(value: unknown): value is ProjectEnvelope {
  if (!hasKeys(value, ['type', 'project', 'projects'])) return false;
  return (
    (PROJECT_EVENT_TYPES as readonly string[]).includes(value.type as string) &&
    Array.isArray(value.projects) &&
    (value.project === null || typeof value.project === 'object')
  );
}

/** Subscribe to `nc:project` registry changes. Returns an unlisten function. */
export async function onProjectEvent(
  handler: (envelope: ProjectEnvelope) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.project, (v) => (isProjectEnvelope(v) ? v : null), handler);
}

/** Narrow an unknown payload to a `LoopEnvelope` defensively. The handler reads
 *  `state`, `maxConcurrency`, `reason`, and `failureThreshold` (the breaker
 *  badge), so the numeric fields it depends on are type-checked too. `LOOP_STATES`
 *  is the single source of truth for the membership check — no hand-enumerated
 *  string literals here. */
function isLoopEnvelope(value: unknown): value is LoopEnvelope {
  if (!hasKeys(value, ['state', 'maxConcurrency', 'failureThreshold'])) return false;
  return (
    (LOOP_STATES as readonly string[]).includes(value.state as string) &&
    typeof value.maxConcurrency === 'number' &&
    typeof value.failureThreshold === 'number'
  );
}

/** Subscribe to `nc:loop` autonomous-loop state changes. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onLoopEvent(
  handler: (envelope: LoopEnvelope) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.loop, (v) => (isLoopEnvelope(v) ? v : null), handler);
}

/** Narrow an unknown payload to a `PermissionPrompt` defensively. The prompt UI
 *  reads `taskId`, `requestId`, `toolName`, and renders `input`, so all four are
 *  checked (`input` must be a non-null object — the surface iterates it). */
function isPermissionPrompt(value: unknown): value is PermissionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'toolName', 'input'])) return false;
  return (
    typeof value.taskId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.input === 'object' &&
    value.input !== null
  );
}

/** Subscribe to `nc:permission` interactive prompts. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onPermissionEvent(
  handler: (prompt: PermissionPrompt) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.permission, (v) => (isPermissionPrompt(v) ? v : null), handler);
}

/** Narrow an unknown payload to a `QuestionPrompt` defensively. The dock reads
 *  `taskId`, `requestId`, and renders `questions`, so all three are checked and the
 *  `questions` array is validated against the contract schema (it arrives over the
 *  dedicated `nc:question` channel, not the zod-validated session stream). */
function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'questions'])) return false;
  if (typeof value.taskId !== 'string' || typeof value.requestId !== 'string') {
    return false;
  }
  return QuestionItemSchema.array().nonempty().safeParse(value.questions).success;
}

/** Subscribe to `nc:question` interactive AskUserQuestion prompts. Returns an
 *  unlisten function (a no-op outside Tauri). */
export async function onQuestionEvent(
  handler: (prompt: QuestionPrompt) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.question, (v) => (isQuestionPrompt(v) ? v : null), handler);
}

// --- Insight (codebase analysis) ------------------------------------------

/** The Insight analysis event family streamed over `nc:insight`, narrowed from
 *  the authoritative `NightcoreEvent` union. */
export type AnalysisEvent = Extract<
  NcEvent,
  {
    type:
      | 'analysis-started'
      | 'analysis-category-started'
      | 'analysis-category-completed'
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

/** Narrow an unknown `nc:insight` payload to an `InsightEvent`. The `analysis-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `finding-converted` notice (not a `NightcoreEvent`) is shape-checked. */
/**
 * Generic narrower for the three scan channels (insight/scorecard/harness). Each
 * carries the authoritative `NightcoreEvent` family for its surface (matched by
 * `wirePrefix` and validated against `NightcoreEventSchema`) PLUS one
 * non-`NightcoreEvent` "notice" the Rust core emits in place (convert/apply), whose
 * `noticeFields` are shape-checked as strings. Returns the typed notice, the
 * validated wire event, or `null`.
 */
function parseChannelEvent<TNotice extends { type: string }, TWire>(
  value: unknown,
  noticeType: TNotice['type'],
  noticeFields: readonly string[],
  wirePrefix: string,
): TNotice | TWire | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === noticeType) {
    if (!noticeFields.every((f) => typeof v[f] === 'string')) return null;
    const notice: Record<string, string> = { type: noticeType };
    for (const f of noticeFields) notice[f] = v[f] as string;
    return notice as TNotice;
  }
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith(wirePrefix)) {
    return parsed.data as TWire;
  }
  return null;
}

function parseInsightEvent(value: unknown): InsightEvent | null {
  return parseChannelEvent<FindingConvertedEvent, AnalysisEvent>(
    value,
    'finding-converted',
    ['runId', 'findingId', 'taskId'],
    'analysis-',
  );
}

/** Subscribe to `nc:insight` streamed analysis events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onInsightEvent(
  handler: (event: InsightEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.insight, parseInsightEvent, handler);
}

// --- PR Review (fourth scan sibling) --------------------------------------

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
      | 'pr-review-completed'
      | 'pr-review-failed'
      | 'pr-review-finding-converted';
  }
>;

/** Narrow an unknown `nc:pr-review` payload to a `PrReviewEvent`. The whole
 *  `pr-review-*` family (including the convert acknowledgement) is a
 *  `NightcoreEvent`, so a single `NightcoreEventSchema` validation + prefix check
 *  is enough — no separate notice branch (unlike Insight). */
function parsePrReviewEvent(value: unknown): PrReviewEvent | null {
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('pr-review-')) {
    return parsed.data as PrReviewEvent;
  }
  return null;
}

/** Subscribe to `nc:pr-review` streamed review events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onPrReviewEvent(
  handler: (event: PrReviewEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.prReview, parsePrReviewEvent, handler);
}

// --- Issue Triage (GitHub issue intake + validation) ----------------------

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

/** Narrow an unknown `nc:issue-triage` payload to an `IssueTriageEvent`. The whole
 *  `issue-validation-*` family (including the convert acknowledgement) is a
 *  `NightcoreEvent`, so a single `NightcoreEventSchema` validation + prefix check is
 *  enough. */
function parseIssueTriageEvent(value: unknown): IssueTriageEvent | null {
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('issue-validation-')) {
    return parsed.data as IssueTriageEvent;
  }
  return null;
}

/** Subscribe to `nc:issue-triage` streamed validation events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onIssueTriageEvent(
  handler: (event: IssueTriageEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.issueTriage, parseIssueTriageEvent, handler);
}

// --- PR fix (address review findings) --------------------------------------

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

/** Narrow an unknown `nc:pr-fix` payload to a `PrFixState` snapshot defensively.
 *  Every state change emits the FULL state, so the fields the fix registry hook
 *  and the fix card actually read are all checked (`summary`/`error` are
 *  nullable; `status` is any string — forward-compatible with statuses newer
 *  than this build, like the list path). INTENTIONALLY PARTIAL like `isTask`:
 *  `runId`/`dir`/`createdAt` ride along untyped-checked. */
function isPrFixState(value: unknown): value is PrFixState {
  if (
    !hasKeys(value, [
      'id',
      'kind',
      'prNumber',
      'branch',
      'status',
      'summary',
      'error',
      'findingCount',
      'updatedAt',
    ])
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.prNumber === 'number' &&
    typeof value.branch === 'string' &&
    typeof value.status === 'string' &&
    (value.summary === null || typeof value.summary === 'string') &&
    (value.error === null || typeof value.error === 'string') &&
    typeof value.findingCount === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

/** Subscribe to `nc:pr-fix` full-state snapshots (one per fix lifecycle change).
 *  Returns an unlisten function (a no-op outside Tauri). */
export async function onPrFixEvent(
  handler: (state: PrFixState) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.prFix, (v) => (isPrFixState(v) ? v : null), handler);
}

// --- Readiness Scorecard (Profile) ----------------------------------------

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

/** Narrow an unknown `nc:scorecard` payload to a `ScorecardEvent`. The `scorecard-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `reading-converted` notice (not a `NightcoreEvent`) is shape-checked. */
function parseScorecardEvent(value: unknown): ScorecardEvent | null {
  return parseChannelEvent<ReadingConvertedEvent, ScorecardWireEvent>(
    value,
    'reading-converted',
    ['runId', 'readingId', 'taskId'],
    'scorecard-',
  );
}

/** Subscribe to `nc:scorecard` streamed events. Returns an unlisten function (a
 *  no-op outside Tauri). */
export async function onScorecardEvent(
  handler: (event: ScorecardEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.scorecard, parseScorecardEvent, handler);
}

// --- Harness (codebase convention auditor) --------------------------------

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

/** Narrow an unknown `nc:harness` payload to a `HarnessEvent`. The channel carries the
 *  `harness-*` wire family plus several non-`NightcoreEvent` notices (`finding-converted`,
 *  `proposal-converted`, `proposal-applied`, `check-armed`, `artifact-applied`). `parseChannelEvent` handles
 *  the `artifact-applied` notice + the wire events, so the object-shaped notices are
 *  shape-checked here first, then the rest is delegated. */
function parseHarnessEvent(value: unknown): HarnessEvent | null {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.type === 'finding-converted') {
      if (
        typeof v.runId === 'string' &&
        typeof v.findingId === 'string' &&
        typeof v.taskId === 'string'
      ) {
        return {
          type: 'finding-converted',
          runId: v.runId,
          findingId: v.findingId,
          taskId: v.taskId,
        };
      }
      return null;
    }
    if (v.type === 'proposal-converted') {
      if (
        typeof v.runId === 'string' &&
        typeof v.proposalId === 'string' &&
        typeof v.taskId === 'string'
      ) {
        return {
          type: 'proposal-converted',
          runId: v.runId,
          proposalId: v.proposalId,
          taskId: v.taskId,
        };
      }
      return null;
    }
    if (v.type === 'proposal-applied') {
      if (
        typeof v.runId === 'string' &&
        typeof v.proposalId === 'string' &&
        typeof v.count === 'number'
      ) {
        return {
          type: 'proposal-applied',
          runId: v.runId,
          proposalId: v.proposalId,
          count: v.count,
        };
      }
      return null;
    }
    if (v.type === 'check-armed') {
      if (
        typeof v.runId === 'string' &&
        typeof v.name === 'string' &&
        typeof v.kind === 'string'
      ) {
        return { type: 'check-armed', runId: v.runId, name: v.name, kind: v.kind };
      }
      return null;
    }
  }
  return parseChannelEvent<ArtifactAppliedEvent, HarnessScanEvent>(
    value,
    'artifact-applied',
    ['runId', 'artifactId', 'path'],
    'harness-',
  );
}

/** Subscribe to `nc:harness` streamed scan events. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onHarnessEvent(
  handler: (event: HarnessEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.harness, parseHarnessEvent, handler);
}
