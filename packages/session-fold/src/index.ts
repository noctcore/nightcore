/**
 * @nightcore/session-fold — the view-neutral core of the session fold.
 *
 * Both the desktop board (`apps/web` `foldSession`/`foldTranscript`, producing a
 * `SessionStream` of interleaved text/tool/task entries) and the TUI
 * (`apps/tui` `reduce`, producing a `SessionView` with a `transcript` array and a
 * `tasks` map) fold the SAME `NightcoreEvent` stream with the SAME assistant
 * partial-dedup + turn-sealing invariant — but into genuinely different view
 * models with different entry shapes, id schemes, and surface-only events.
 *
 * This package owns ONLY the part that is identical across both: the assistant
 * partial-vs-whole-message dedup decision and the `streamedPartial` flag
 * arithmetic (M0's dedup, mirrored by the CLI). Each surface keeps a thin
 * adapter that maps the neutral decision onto its own entry container, its own
 * id scheme, its turn-open policy, and its surface-specific events
 * (web's `closed`/timeline tools+tasks; the TUI's `tool-result`,
 * `permission-required`, `question-required`, and `ui-*` actions).
 *
 * Sharing only the decision keeps reseed parity intact in both apps: the same
 * recorded event sequence yields the same decisions, and each adapter
 * materializes them deterministically.
 */

/**
 * What to do with an `assistant-delta` event, decided purely from the dedup
 * state. The adapter applies it to its own entry container:
 *  - `append` — concatenate the delta text onto the currently-open assistant turn.
 *  - `open`   — start a fresh assistant turn carrying the delta text.
 *  - `suppress` — drop the event (the whole-message duplicate of a turn that
 *    already streamed partials; the open turn already holds the full text).
 */
export type AssistantDeltaAction = 'append' | 'open' | 'suppress';

/** The partial-dedup decision plus the `streamedPartial` flag that results. */
export interface AssistantDeltaDecision {
  action: AssistantDeltaAction;
  /** The `streamedPartial` flag AFTER this event. Unchanged on `suppress`. */
  streamedPartial: boolean;
}

/** Inputs to the dedup decision — each surface supplies its own notion of
 *  "is there an assistant turn currently open to append to". (Web reads "the last
 *  timeline entry is an unsealed text turn"; the TUI reads "activeAssistantId is
 *  set".) The decision itself is identical given these. */
export interface AssistantDeltaInput {
  /** True when this delta is an incremental stream chunk; false for the
   *  whole-message fallback block the SDK re-emits at end of turn. */
  partial: boolean;
  /** Whether the current turn has already streamed `partial` deltas. */
  streamedPartial: boolean;
  /** Whether the surface currently has an open assistant turn to append to. */
  hasOpenTurn: boolean;
}

/**
 * Decide how to fold one `assistant-delta`, mirroring M0/CLI dedup:
 *  - A `partial` delta extends the turn — append to the open turn, or open a new
 *    one — and marks the turn as having streamed partials.
 *  - A whole-message block (`partial: false`) is SUPPRESSED once partials have
 *    streamed (the open turn already holds the full text); otherwise it opens a
 *    fresh turn and leaves `streamedPartial` false.
 *
 * Pure. Whether a freshly-opened turn stays "open" for a later delta is a
 * view-specific policy the adapter owns (the web board keeps a kept whole-message
 * turn open; the TUI closes it), so it is deliberately NOT decided here.
 */
export function decideAssistantDelta(
  input: AssistantDeltaInput,
): AssistantDeltaDecision {
  if (input.partial) {
    return {
      action: input.hasOpenTurn ? 'append' : 'open',
      streamedPartial: true,
    };
  }
  // Whole-message block: drop it when partials already streamed this turn.
  if (input.streamedPartial) {
    return { action: 'suppress', streamedPartial: true };
  }
  return { action: 'open', streamedPartial: false };
}

/**
 * The `streamedPartial` flag after a turn-ending boundary (a tool use, a new
 * subagent step, or the session completing): the turn is sealed, so the next
 * whole-message block prints again rather than being suppressed. Each adapter
 * pairs this with its own seal of the open entry (web closes the text turn; the
 * TUI clears `activeAssistantId`).
 */
export function streamedPartialAfterBoundary(): boolean {
  return false;
}

/** The `streamedPartial` flag for a fresh/empty session (start, ready, clear). */
export const INITIAL_STREAMED_PARTIAL = false;
