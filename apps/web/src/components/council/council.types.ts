/**
 * Council canvas feature-local types (issue #352).
 *
 * The canvas is a pure READER of the `nc:debate` transcript stream — it folds the
 * append-only entries into seat nodes + a team-chat projection and never feeds text
 * back into a seat prompt (the conductor-mediated, quoted, injection-scanned bus stays
 * the sole cross-seat path — safety #1/#2). These shapes are the folded view the
 * components render; the wire shape is the contract `DebateTranscriptEntry`.
 */
import type {
  DebateEntryKind,
  DebateSeatRole,
  DebateStage,
} from '@/lib/bridge';

/** One of a seat's own contributions onto the bus (a `message` entry), kept in seq
 *  order so a seat node renders its stream oldest → newest. */
export interface SeatMessage {
  /** The store-assigned monotonic sequence (the stable React key + replay order). */
  seq: number;
  /** The stage the contribution belongs to (Frame → Propose → Debate → Converge). */
  stage: DebateStage;
  /** The seat's output text (markdown). */
  content: string;
}

/** One seat's node on the canvas: its identity, asymmetric role, and its own message
 *  stream. Derived from the transcript — a seat appears once it first speaks. */
export interface SeatStream {
  /** The system-minted seat id (never agent-supplied). */
  seatId: string;
  /** The seat's asymmetric role (proposer / critic / judge). */
  role: DebateSeatRole;
  /** Every `message` the seat authored, in seq order. */
  messages: SeatMessage[];
  /** The seat's most recent contribution (what the node shows prominently). */
  latestContent: string;
  /** The stage the seat's latest contribution belongs to. */
  latestStage: DebateStage;
}

/** One line in the team-chat projection — a human-readable rendering of a single bus
 *  entry (any kind, any author, including the conductor's broadcasts + notes). */
export interface TeamChatEntry {
  /** The store-assigned monotonic sequence (the stable React key + order). */
  seq: number;
  /** The authoring seat, or the conductor for a broadcast/note (source seat for a
   *  quoted delivery). */
  seatId: string;
  /** The author's role. */
  role: DebateSeatRole;
  /** What kind of bus write produced the entry. */
  kind: DebateEntryKind;
  /** The stage the entry belongs to. */
  stage: DebateStage;
  /** The entry text (a delivery's is already quoted + injection-scanned). */
  content: string;
  /** Append timestamp (epoch ms). */
  at: number;
  /** The shared broadcast id grouping one broadcast's replies, when present. */
  broadcastId?: string;
  /** The injection-scan reasons for a `delivery` (present ⇒ safety #2's scan ran). */
  injectionFlags?: string[];
}

/** The folded transcript the canvas renders: the seat nodes + the full team-chat. */
export interface CouncilTranscript {
  /** Seat nodes, in first-appearance order. */
  seats: SeatStream[];
  /** The full bus projection, in seq order. */
  chat: TeamChatEntry[];
}

/** The canvas lifecycle phase, tracked web-side (the run result stays engine-side; the
 *  canvas infers phase from the stream + the human's start/kill actions). */
export type CouncilPhase =
  /** No run started — the start panel is shown. */
  | 'idle'
  /** A run is live — seats are debating. */
  | 'running'
  /** The run parked a Converge decision for the human judge (a converge note arrived);
   *  #353 wires the judge/accept/reject UI. */
  | 'converged'
  /** The human threw the kill switch (safety #4). */
  | 'stopped';
