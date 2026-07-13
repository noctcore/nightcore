/**
 * The single registry of every `nc:*` Tauri event channel the harness emits on,
 * and the ONLY place a channel name is authored. Both tiers consume it:
 *
 *  - **Web** (`apps/web/src/lib/bridge/events.ts`) subscribes via `CHANNELS.*`
 *    instead of raw `nc:` string literals, so a rename here can't silently drift
 *    the board.
 *  - **Rust** — `tools/codegen/gen-rust-contracts.ts` emits this map into
 *    `contracts/generated.rs` as `NIGHTCORE_CHANNELS`, and the `contracts/mod.rs`
 *    conformance test asserts every scattered `*_EVENT` const equals its entry.
 *    A channel renamed on either tier therefore fails `cargo test` (and a rename
 *    here also reds `lint:meta` codegen-drift until `generated.rs` is regenerated).
 *
 * The payload SHAPE for each channel is defined elsewhere (the `NightcoreEvent`
 * union, `LoopEnvelope`, `PrFixState`, the project/permission/question envelopes);
 * this registry pins only the wire channel NAME.
 */
export const CHANNELS = {
  /** One streamed engine event tagged with its task (`{ taskId, event }`). */
  session: 'nc:session',
  /** An interactive permission prompt for a running task. */
  permission: 'nc:permission',
  /** An interactive `AskUserQuestion` prompt for a running task. */
  question: 'nc:question',
  /** The full task, emitted on every change so the board can upsert. */
  task: 'nc:task',
  /** A project-registry change plus the full registry snapshot. */
  project: 'nc:project',
  /** The autonomous auto-loop's state snapshot. */
  loop: 'nc:loop',
  /** One streamed Insight `analysis-*` event (raw `NightcoreEvent`). */
  insight: 'nc:insight',
  /** One streamed Harness `harness-*` event (raw `NightcoreEvent`). */
  harness: 'nc:harness',
  /** One streamed Scorecard `scorecard-*` event (raw `NightcoreEvent`). */
  scorecard: 'nc:scorecard',
  /** One streamed PR Review `pr-review-*` event (raw `NightcoreEvent`). */
  prReview: 'nc:pr-review',
  /** One streamed Issue Triage `issue-validation-*` event. */
  issueTriage: 'nc:issue-triage',
  /** The full pr-fix state snapshot on every lifecycle change. */
  prFix: 'nc:pr-fix',
  /** The provider usage meter snapshot, pushed on every poll change (issue #121). */
  usage: 'nc:usage',
  /** One append-only Council debate-transcript entry for a council run (`nc:debate`,
   *  issue #348). Payload is a {@link import('./debate.js').DebateTranscriptEntry}
   *  scoped by its council-run id. Registered ahead of its emitter: the moderated bus
   *  and transcript store are the Council P1 foundation; the Rust Conductor emit seam
   *  arrives in a downstream slice. */
  debate: 'nc:debate',
} as const;

/** A registry symbol (e.g. `'prReview'`) — the key side of {@link CHANNELS}. */
export type ChannelKey = keyof typeof CHANNELS;

/** A wire channel name (e.g. `'nc:pr-review'`) — the value side of {@link CHANNELS}. */
export type ChannelName = (typeof CHANNELS)[ChannelKey];
