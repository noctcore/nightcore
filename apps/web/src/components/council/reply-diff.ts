/**
 * Group a run's transcript into side-by-side reply rounds (issue #353).
 *
 * When the conductor broadcasts one prompt to N seats, their replies all carry the
 * SAME `broadcastId` (Propose's blind round, each Debate round). This pure fold groups
 * those replies by broadcast so the {@link import('./ReplyDiff').ReplyDiff} can render
 * them side-by-side — disagreement is the PRODUCT, so the columns are never merged into
 * one view. Deduped + ordered by the store-assigned `seq`, so a re-delivered or
 * out-of-order wire event can't double a column or reorder the rounds (safety #7).
 */
import type { DebateSeatRole, DebateStage, DebateTranscriptEntry } from '@/lib/bridge';

/** One seat's reply within a broadcast round — a single column in the side-by-side diff. */
export interface ReplyColumn {
  /** The seat that authored the reply. */
  seatId: string;
  /** The seat's asymmetric role (proposer / critic / judge). */
  role: DebateSeatRole;
  /** The store-assigned sequence (the stable React key + replay order). */
  seq: number;
  /** The seat's reply text (markdown). */
  content: string;
}

/** One broadcast round's replies, grouped for the side-by-side diff. */
export interface ReplyRound {
  /** The shared broadcast id every column replied to (the group key + stable React key). */
  broadcastId: string;
  /** The stage the round belongs to (propose / debate). */
  stage: DebateStage;
  /** A human label, e.g. "Propose" or "Debate · round 2". */
  label: string;
  /** True for the most recent round — the final positions the human judges at Converge. */
  isFinal: boolean;
  /** Whether the columns' replies actually differ (diverged) or are all identical
   *  (aligned). Surfaces where the seats disagree without a fake semantic merge. */
  diverged: boolean;
  /** The seat replies, in first-seen seat order (left-to-right). */
  columns: ReplyColumn[];
}

/** Human title per state-machine stage — shared with the live-stage pill (GOV-6). */
export const STAGE_LABEL: Record<DebateStage, string> = {
  frame: 'Frame',
  propose: 'Propose',
  debate: 'Debate',
  converge: 'Converge',
  build: 'Build',
  review: 'Review',
};

interface RoundGroup {
  readonly stage: DebateStage;
  readonly columns: Map<string, ReplyColumn>;
}

/** True when a transcript entry is a seat's OWN broadcast reply — a `message` authored
 *  by a debating seat that is linked to a broadcast (not a conductor line, not the human
 *  gavel, not an unlinked message). These are the columns the reply diff renders. */
function isBroadcastReply(entry: DebateTranscriptEntry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role !== 'conductor' &&
    entry.role !== 'human' &&
    entry.broadcastId !== undefined
  );
}

/** Group a run's transcript entries into ordered, side-by-side reply rounds. Rounds are
 *  in chronological (ascending-seq) order; the last is flagged `isFinal`. A stage with
 *  more than one round gets a "· round N" suffix so Debate rounds read distinctly. */
export function groupReplyRounds(
  entries: readonly DebateTranscriptEntry[],
): ReplyRound[] {
  // Dedupe by the store-assigned seq (last-write-wins), then order — robust against a
  // wire reorder/re-delivery, mirroring `foldCouncilTranscript`.
  const bySeq = new Map<number, DebateTranscriptEntry>();
  for (const entry of entries) bySeq.set(entry.seq, entry);
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  // Insertion order of `groups` follows ascending seq (chronological), since `ordered`
  // is sorted — so the last group is the most recent round.
  const groups = new Map<string, RoundGroup>();
  for (const entry of ordered) {
    if (!isBroadcastReply(entry)) continue;
    const broadcastId = entry.broadcastId as string;
    let group = groups.get(broadcastId);
    if (group === undefined) {
      group = { stage: entry.stage, columns: new Map() };
      groups.set(broadcastId, group);
    }
    group.columns.set(entry.seatId, {
      seatId: entry.seatId,
      role: entry.role,
      seq: entry.seq,
      content: entry.content,
    });
  }

  const stageTotals = new Map<DebateStage, number>();
  for (const group of groups.values()) {
    stageTotals.set(group.stage, (stageTotals.get(group.stage) ?? 0) + 1);
  }

  const stageSeen = new Map<DebateStage, number>();
  const groupList = [...groups.entries()];
  return groupList.map(([broadcastId, group], index) => {
    const ordinal = (stageSeen.get(group.stage) ?? 0) + 1;
    stageSeen.set(group.stage, ordinal);
    const base = STAGE_LABEL[group.stage];
    const label =
      (stageTotals.get(group.stage) ?? 0) > 1 ? `${base} · round ${ordinal}` : base;
    const columns = [...group.columns.values()];
    const diverged = new Set(columns.map((c) => c.content.trim())).size > 1;
    return {
      broadcastId,
      stage: group.stage,
      label,
      isFinal: index === groupList.length - 1,
      diverged,
      columns,
    };
  });
}
