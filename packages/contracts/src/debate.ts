import { z } from 'zod';

/**
 * Council debate-transcript contract (issue #348 — the P1 foundation slice).
 *
 * A Council run is a governed multi-agent debate: heterogeneous "seats" (each a
 * provider session) emit onto a MODERATED bus, scoped by stage, and a conductor
 * — an orchestrator, never a peer — owns turn-taking and routing. The bus write
 * path is the conductor's alone; seats have zero authority to write into each
 * other's context (safety non-negotiable #1, the injection firewall). Every write
 * is recorded as one immutable {@link DebateTranscriptEntry}, so the whole run is
 * auditable and replayable in order (safety non-negotiable #7).
 *
 * This is the SINGLE SOURCE OF TRUTH for the transcript-entry shape the engine's
 * append-only store persists and the `nc:debate` Tauri channel will carry (see
 * `CHANNELS.debate`). It is a standalone zod schema, NOT a `NightcoreEvent` union
 * member: no debate events are emitted yet (the Rust Conductor emit seam is a
 * downstream slice), so the entry is a data-model contract, not a wire event that
 * rides the zod→Rust event-union codegen. The engine transcript store consumes it
 * directly.
 */

/**
 * The Council state-machine stage a transcript entry belongs to. Mirrors the
 * design's `Frame → Propose → Debate → Converge → Build → Review` loop; the bus is
 * scoped by stage so an entry always records which phase produced it.
 */
export const DebateStageSchema = z.enum([
  'frame',
  'propose',
  'debate',
  'converge',
  'build',
  'review',
]);
export type DebateStage = z.infer<typeof DebateStageSchema>;

/**
 * The asymmetric role of the author of a transcript entry. Asymmetric roles
 * (proposer vs. adversary/critic vs. judge) are what make debate produce genuine
 * disagreement rather than an echo. `conductor` is the moderator/orchestrator that
 * owns every write; `human` is the terminal judge (the human gavel).
 */
export const DebateSeatRoleSchema = z.enum([
  'proposer',
  'critic',
  'judge',
  'conductor',
  'human',
]);
export type DebateSeatRole = z.infer<typeof DebateSeatRoleSchema>;

/**
 * What kind of write produced this entry:
 *  - `broadcast` — a conductor prompt sent to all seats at once (mints a
 *    `broadcastId` the replies carry).
 *  - `message` — a seat's own contribution onto the bus (a proposal/critique;
 *    `role` distinguishes which).
 *  - `delivery` — a QUOTED-UNTRUSTED inter-seat message: another seat's text
 *    relayed as data (`Seat B said: "…"`), injection-scanned before delivery, never
 *    an instruction. `injectionFlags` records the scan result (safety #2).
 *  - `note` — a conductor/system annotation (a stage transition, a moderation note).
 */
export const DebateEntryKindSchema = z.enum([
  'broadcast',
  'message',
  'delivery',
  'note',
]);
export type DebateEntryKind = z.infer<typeof DebateEntryKindSchema>;

/**
 * One immutable entry in a council run's append-only transcript. Keyed in the
 * store by its council-run id (so the entry does NOT carry that id). `seq` is a
 * per-run monotonic index the store assigns on append; an ordered read by `seq`
 * reconstructs the exact sequence for replay (safety #7). Entries are NEVER mutated
 * or deleted — append-only is a hard invariant.
 */
export const DebateTranscriptEntrySchema = z.object({
  /** The state-machine stage this entry belongs to (the bus is stage-scoped). */
  stage: DebateStageSchema,
  /** The authoring seat's id, or the conductor's id for `broadcast`/`note`. For a
   *  `delivery`, the SOURCE seat whose text is being relayed as quoted data. */
  seatId: z.string(),
  /** The author's asymmetric role. */
  role: DebateSeatRoleSchema,
  /** What kind of write produced the entry. */
  kind: DebateEntryKindSchema,
  /** Store-assigned per-run monotonic sequence — the replay ordering key. */
  seq: z.number().int().nonnegative(),
  /** The entry's text. For a `delivery`, the QUOTED, injection-scanned rendering
   *  (never a bare instruction). */
  content: z.string(),
  /** Present on a `broadcast` and every reply linked to it: the shared broadcast id
   *  that groups one broadcast's side-by-side replies. Absent otherwise. */
  broadcastId: z.string().optional(),
  /** Store-assigned append timestamp (epoch ms) — audit metadata. */
  at: z.number().int().nonnegative(),
  /** The injection-scan reasons for a `delivery` entry: PRESENT (possibly empty =
   *  scanned-clean) on every inter-seat delivery, ABSENT on non-delivery entries.
   *  Records that safety #2's scan ran and what it found. */
  injectionFlags: z.array(z.string()).optional(),
});
export type DebateTranscriptEntry = z.infer<typeof DebateTranscriptEntrySchema>;
