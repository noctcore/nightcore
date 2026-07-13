/**
 * The web↔Rust bridge's EVENT surface: every `nc:*` `listen` subscription the board
 * uses, the event payload types they deliver, and the defensive narrowers that
 * validate each payload against the authoritative `@nightcore/contracts` schemas
 * before dispatch. Outside the Tauri webview every subscription is a silent no-op.
 */
import { type EventCallback, listen, type UnlistenFn } from '@tauri-apps/api/event';

import { CHANNELS } from '@nightcore/contracts';

import {
  isLoopEnvelope,
  isPermissionPrompt,
  isPrFixState,
  isProjectEnvelope,
  isQuestionPrompt,
  isTask,
  isUsageMeter,
  parseDebateEvent,
  parseHarnessEvent,
  parseInsightEvent,
  parseIssueMapProgress,
  parseIssueTriageEvent,
  parsePrReviewEvent,
  parseScorecardEvent,
  parseSessionEnvelope,
} from './events.narrowers';
import type {
  DebateEvent,
  HarnessEvent,
  InsightEvent,
  IssueMapProgress,
  IssueTriageEvent,
  PermissionPrompt,
  ProjectEnvelope,
  PrReviewEvent,
  QuestionPrompt,
  ScorecardEvent,
  SessionEnvelope,
} from './events.types';
import { isTauri } from './internal';
import type { LoopEnvelope, PrFixState, Task, UsageMeter } from './types';

export type {
  AnalysisEvent,
  ArtifactAppliedEvent,
  DebateEvent,
  FindingConvertedEvent,
  HarnessCheckArmedEvent,
  HarnessEvent,
  HarnessFindingConvertedEvent,
  HarnessProposalAppliedEvent,
  HarnessProposalConvertedEvent,
  HarnessScanEvent,
  InsightEvent,
  IssueMapProgress,
  IssueTriageEvent,
  LoopState,
  PermissionPrompt,
  PrFixStatus,
  ProjectEnvelope,
  ProjectEventType,
  PrReviewEvent,
  QuestionPrompt,
  ReadingConvertedEvent,
  ScorecardEvent,
  ScorecardWireEvent,
  SessionEnvelope,
} from './events.types';

// --- Events ---------------------------------------------------------------

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

/** Subscribe to `nc:project` registry changes. Returns an unlisten function. */
export async function onProjectEvent(
  handler: (envelope: ProjectEnvelope) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.project, (v) => (isProjectEnvelope(v) ? v : null), handler);
}

/** Subscribe to `nc:loop` autonomous-loop state changes. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onLoopEvent(
  handler: (envelope: LoopEnvelope) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.loop, (v) => (isLoopEnvelope(v) ? v : null), handler);
}

/** Subscribe to `nc:permission` interactive prompts. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onPermissionEvent(
  handler: (prompt: PermissionPrompt) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.permission, (v) => (isPermissionPrompt(v) ? v : null), handler);
}

/** Subscribe to `nc:question` interactive AskUserQuestion prompts. Returns an
 *  unlisten function (a no-op outside Tauri). */
export async function onQuestionEvent(
  handler: (prompt: QuestionPrompt) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.question, (v) => (isQuestionPrompt(v) ? v : null), handler);
}

/** Subscribe to `nc:insight` streamed analysis events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onInsightEvent(
  handler: (event: InsightEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.insight, parseInsightEvent, handler);
}

/** Subscribe to `nc:pr-review` streamed review events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onPrReviewEvent(
  handler: (event: PrReviewEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.prReview, parsePrReviewEvent, handler);
}

/** Subscribe to `nc:issue-triage` streamed validation events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onIssueTriageEvent(
  handler: (event: IssueTriageEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.issueTriage, parseIssueTriageEvent, handler);
}

/** Subscribe to `nc:pr-fix` full-state snapshots (one per fix lifecycle change).
 *  Returns an unlisten function (a no-op outside Tauri). */
export async function onPrFixEvent(
  handler: (state: PrFixState) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.prFix, (v) => (isPrFixState(v) ? v : null), handler);
}

/** Subscribe to `nc:debate` streamed transcript entries (issue #352). Each event is
 *  one append-only entry tagged with its council `runId`; the canvas folds them into
 *  seat nodes + the team-chat projection. Returns an unlisten function (a no-op outside
 *  Tauri). */
export async function onDebateEvent(
  handler: (event: DebateEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.debate, parseDebateEvent, handler);
}

/** Subscribe to `nc:scorecard` streamed events. Returns an unlisten function (a
 *  no-op outside Tauri). */
export async function onScorecardEvent(
  handler: (event: ScorecardEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.scorecard, parseScorecardEvent, handler);
}

/** Subscribe to `nc:harness` streamed scan events. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onHarnessEvent(
  handler: (event: HarnessEvent) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.harness, parseHarnessEvent, handler);
}

/** Subscribe to `nc:usage` provider-usage-meter snapshots (the full meter, pushed
 *  on every poll change; issue #121). The `get_usage` command is the fetch-on-mount
 *  source of truth — this push only saves the widget from waiting up to 10 min for
 *  the next change. Returns an unlisten function (a no-op outside Tauri). */
export async function onUsageEvent(
  handler: (meter: UsageMeter) => void,
): Promise<UnlistenFn> {
  return subscribeChannel(CHANNELS.usage, (v) => (isUsageMeter(v) ? v : null), handler);
}

/** Subscribe to the transient `nc:issue-map` export-progress ticks. This channel
 *  is deliberately a raw string, NOT a `CHANNELS.*` entry: it is a cosmetic
 *  `created k/N` progress emit (no persistence, the terminal `IssueMapResult` is
 *  the source of truth), so it never joined the registry that mirrors into the
 *  Rust `NIGHTCORE_CHANNELS` codegen. Returns an unlisten function (a no-op
 *  outside Tauri). */
export async function onIssueMapEvent(
  handler: (event: IssueMapProgress) => void,
): Promise<UnlistenFn> {
  return subscribeChannel('nc:issue-map', parseIssueMapProgress, handler);
}
