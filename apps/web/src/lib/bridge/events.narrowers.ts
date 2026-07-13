/**
 * The defensive narrowers guarding every `nc:*` event payload before dispatch.
 * Each validates an `unknown` payload against the fields its surface actually
 * reads — several delegate to the authoritative `@nightcore/contracts` zod
 * schemas — and returns the typed value or `null` to drop a malformed payload.
 */
import { NightcoreEventSchema, QuestionItemSchema } from '@nightcore/contracts';

import type {
  AnalysisEvent,
  ArtifactAppliedEvent,
  DebateEvent,
  FindingConvertedEvent,
  HarnessEvent,
  HarnessScanEvent,
  InsightEvent,
  IssueMapProgress,
  IssueTriageEvent,
  LoopState,
  PermissionPrompt,
  ProjectEnvelope,
  ProjectEventType,
  PrReviewEvent,
  QuestionPrompt,
  ReadingConvertedEvent,
  ScorecardEvent,
  ScorecardWireEvent,
  SessionEnvelope,
} from './events.types';
import type { LoopEnvelope, PrFixState, Task, UsageMeter } from './types';

/** Runtime membership array for `ProjectEventType`. Must stay exhaustive: the
 *  `satisfies` clause makes adding a variant to `ProjectEventType` without adding
 *  it here a compile error. The guard uses this array directly — no
 *  hand-enumerated strings at the call site. */
const PROJECT_EVENT_TYPES = ['created', 'deleted', 'activated', 'renamed', 'updated'] as const satisfies readonly ProjectEventType[];

/** Runtime membership array for `LoopState`. Must stay exhaustive: the `satisfies`
 *  clause makes adding a state to `LoopState` without adding it here a compile
 *  error. The guard uses this array directly — no hand-enumerated strings at the
 *  call site. */
const LOOP_STATES = ['running', 'drained', 'paused'] as const satisfies readonly LoopState[];

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
export function isTask(value: unknown): value is Task {
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
export function parseSessionEnvelope(value: unknown): SessionEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== 'string') return null;
  const parsed = NightcoreEventSchema.safeParse(v.event);
  if (!parsed.success) return null;
  return { taskId: v.taskId, event: parsed.data };
}

/** Narrow an unknown payload to a `ProjectEnvelope` defensively. The handler reads
 *  `type`, the full `projects` snapshot, and `project` (for activated/renamed), so
 *  all three are checked: a valid `type`, an array `projects`, and `project` being
 *  an object-or-null. `PROJECT_EVENT_TYPES` is the single source of truth for the
 *  membership check — no hand-enumerated string literals here. */
export function isProjectEnvelope(value: unknown): value is ProjectEnvelope {
  if (!hasKeys(value, ['type', 'project', 'projects'])) return false;
  return (
    (PROJECT_EVENT_TYPES as readonly string[]).includes(value.type as string) &&
    Array.isArray(value.projects) &&
    (value.project === null || typeof value.project === 'object')
  );
}

/** Narrow an unknown payload to a `LoopEnvelope` defensively. The handler reads
 *  `state`, `armed` (the toggle's arming truth), `maxConcurrency`, `reason`, and
 *  `failureThreshold` (the breaker badge), so the boolean + numeric fields it
 *  depends on are type-checked too. `LOOP_STATES` is the single source of truth for
 *  the membership check — no hand-enumerated string literals here. */
export function isLoopEnvelope(value: unknown): value is LoopEnvelope {
  if (!hasKeys(value, ['state', 'armed', 'maxConcurrency', 'failureThreshold'])) return false;
  return (
    (LOOP_STATES as readonly string[]).includes(value.state as string) &&
    typeof value.armed === 'boolean' &&
    typeof value.maxConcurrency === 'number' &&
    typeof value.failureThreshold === 'number'
  );
}

/** Narrow an unknown payload to a `PermissionPrompt` defensively. The prompt UI
 *  reads `taskId`, `requestId`, `toolName`, and renders `input`, so all four are
 *  checked (`input` must be a non-null object — the surface iterates it). */
export function isPermissionPrompt(value: unknown): value is PermissionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'toolName', 'input'])) return false;
  return (
    typeof value.taskId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.input === 'object' &&
    value.input !== null
  );
}

/** Narrow an unknown payload to a `QuestionPrompt` defensively. The dock reads
 *  `taskId`, `requestId`, and renders `questions`, so all three are checked and the
 *  `questions` array is validated against the contract schema (it arrives over the
 *  dedicated `nc:question` channel, not the zod-validated session stream). */
export function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'questions'])) return false;
  if (typeof value.taskId !== 'string' || typeof value.requestId !== 'string') {
    return false;
  }
  return QuestionItemSchema.array().nonempty().safeParse(value.questions).success;
}

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

/** Narrow an unknown `nc:insight` payload to an `InsightEvent`. The `analysis-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `finding-converted` notice (not a `NightcoreEvent`) is shape-checked. */
export function parseInsightEvent(value: unknown): InsightEvent | null {
  return parseChannelEvent<FindingConvertedEvent, AnalysisEvent>(
    value,
    'finding-converted',
    ['runId', 'findingId', 'taskId'],
    'analysis-',
  );
}

/** Narrow an unknown `nc:pr-review` payload to a `PrReviewEvent`. The whole
 *  `pr-review-*` family (including the convert acknowledgement) is a
 *  `NightcoreEvent`, so a single `NightcoreEventSchema` validation + prefix check
 *  is enough — no separate notice branch (unlike Insight). */
export function parsePrReviewEvent(value: unknown): PrReviewEvent | null {
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('pr-review-')) {
    return parsed.data as PrReviewEvent;
  }
  return null;
}

/** Narrow an unknown `nc:issue-triage` payload to an `IssueTriageEvent`. The whole
 *  `issue-validation-*` family (including the convert acknowledgement) is a
 *  `NightcoreEvent`, so a single `NightcoreEventSchema` validation + prefix check is
 *  enough. */
export function parseIssueTriageEvent(value: unknown): IssueTriageEvent | null {
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('issue-validation-')) {
    return parsed.data as IssueTriageEvent;
  }
  return null;
}

/** Narrow an unknown `nc:debate` payload to a `DebateEvent` (issue #352). The whole
 *  `debate-*` family is a `NightcoreEvent`, so a single `NightcoreEventSchema`
 *  validation + exact-`type` check is enough — the inner transcript entry is validated
 *  by the union member, so a malformed/future payload is dropped rather than folded
 *  into the canvas. */
export function parseDebateEvent(value: unknown): DebateEvent | null {
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type === 'debate-entry') {
    return parsed.data as DebateEvent;
  }
  return null;
}

/** Narrow an unknown `nc:pr-fix` payload to a `PrFixState` snapshot defensively.
 *  Every state change emits the FULL state, so the fields the fix registry hook
 *  and the fix card actually read are all checked (`summary`/`error` are
 *  nullable; `status` is any string — forward-compatible with statuses newer
 *  than this build, like the list path). INTENTIONALLY PARTIAL like `isTask`:
 *  `runId`/`dir`/`createdAt` ride along untyped-checked. */
export function isPrFixState(value: unknown): value is PrFixState {
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

/** Narrow an unknown `nc:scorecard` payload to a `ScorecardEvent`. The `scorecard-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `reading-converted` notice (not a `NightcoreEvent`) is shape-checked. */
export function parseScorecardEvent(value: unknown): ScorecardEvent | null {
  return parseChannelEvent<ReadingConvertedEvent, ScorecardWireEvent>(
    value,
    'reading-converted',
    ['runId', 'readingId', 'taskId'],
    'scorecard-',
  );
}

/** Narrow an unknown `nc:harness` payload to a `HarnessEvent`. The channel carries the
 *  `harness-*` wire family plus several non-`NightcoreEvent` notices (`finding-converted`,
 *  `proposal-converted`, `proposal-applied`, `check-armed`, `artifact-applied`). `parseChannelEvent` handles
 *  the `artifact-applied` notice + the wire events, so the object-shaped notices are
 *  shape-checked here first, then the rest is delegated. */
export function parseHarnessEvent(value: unknown): HarnessEvent | null {
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

/** Narrow an unknown `nc:usage` payload to a `UsageMeter` snapshot defensively.
 *  The poller emits the FULL meter on every change; the widget reads `providers`
 *  (and each row's `status`/`windows`), so the top-level `providers` array is the
 *  membership gate. INTENTIONALLY PARTIAL like `isTask`: the per-row fields are the
 *  generated shape and degrade per-row, so a single array check is enough here. */
export function isUsageMeter(value: unknown): value is UsageMeter {
  if (!hasKeys(value, ['providers'])) return false;
  return Array.isArray(value.providers);
}

/** Narrow an unknown `nc:issue-map` payload to a progress tick. Only the
 *  `progress` shape is emitted today; a `type` guard keeps the subscriber
 *  forward-safe if future ticks add variants. Drops anything malformed. */
export function parseIssueMapProgress(value: unknown): IssueMapProgress | null {
  if (!hasKeys(value, ['type', 'runId', 'created', 'total'])) return null;
  if (
    value.type !== 'progress' ||
    typeof value.runId !== 'string' ||
    typeof value.created !== 'number' ||
    typeof value.total !== 'number'
  ) {
    return null;
  }
  return { type: 'progress', runId: value.runId, created: value.created, total: value.total };
}
