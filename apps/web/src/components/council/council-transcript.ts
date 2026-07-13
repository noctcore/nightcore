/**
 * Fold the `nc:debate` transcript into the canvas view (issue #352).
 *
 * Pure + side-effect-free so it is unit-testable without the bridge: given the
 * append-only entries a run has streamed so far, it produces the seat nodes (each
 * seat's own contributions) and the full team-chat projection (every bus write, in
 * order). Entries are deduped + sorted by their store-assigned `seq`, so an
 * out-of-order or re-delivered wire event can never corrupt the ordering or double a
 * line (safety #7: the transcript reconstructs in exact sequence).
 */
import type { DebateTranscriptEntry } from '@/lib/bridge';

import type {
  CouncilTranscript,
  SeatStream,
  TeamChatEntry,
} from './council.types';

/** True when a transcript entry is a seat's OWN contribution — a `message` authored by
 *  a debating seat (not a conductor broadcast/note, not the human gavel). These are the
 *  entries a seat NODE renders; everything else is a conductor/system line the team-chat
 *  still shows. */
function isSeatContribution(entry: DebateTranscriptEntry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role !== 'conductor' &&
    entry.role !== 'human'
  );
}

/** Fold a run's transcript entries into the seat nodes + team-chat the canvas renders.
 *  Deduped + ordered by `seq`; the seat set is derived from the stream, so a seat node
 *  appears the moment that seat first contributes. */
export function foldCouncilTranscript(
  entries: readonly DebateTranscriptEntry[],
): CouncilTranscript {
  // Dedupe by the store-assigned monotonic seq (last-write-wins), then order — the wire
  // is append-ordered, but this keeps the fold robust against a re-delivery/reorder.
  const bySeq = new Map<number, DebateTranscriptEntry>();
  for (const entry of entries) bySeq.set(entry.seq, entry);
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const seatMap = new Map<string, SeatStream>();
  const chat: TeamChatEntry[] = [];

  for (const entry of ordered) {
    chat.push({
      seq: entry.seq,
      seatId: entry.seatId,
      role: entry.role,
      kind: entry.kind,
      stage: entry.stage,
      content: entry.content,
      at: entry.at,
      ...(entry.broadcastId !== undefined ? { broadcastId: entry.broadcastId } : {}),
      ...(entry.injectionFlags !== undefined
        ? { injectionFlags: entry.injectionFlags }
        : {}),
    });

    if (!isSeatContribution(entry)) continue;

    const existing = seatMap.get(entry.seatId);
    const message = { seq: entry.seq, stage: entry.stage, content: entry.content };
    if (existing === undefined) {
      seatMap.set(entry.seatId, {
        seatId: entry.seatId,
        role: entry.role,
        messages: [message],
        latestContent: entry.content,
        latestStage: entry.stage,
      });
    } else {
      existing.messages.push(message);
      existing.latestContent = entry.content;
      existing.latestStage = entry.stage;
    }
  }

  return { seats: [...seatMap.values()], chat };
}

/** Whether the run has parked a Converge decision — a conductor `note` in the
 *  `converge` stage. Drives the canvas phase (`running` → `converged`); #353 wires the
 *  human judge/accept/reject on top of this signal. */
export function hasConvergeDecision(
  entries: readonly DebateTranscriptEntry[],
): boolean {
  return entries.some(
    (entry) => entry.stage === 'converge' && entry.kind === 'note',
  );
}
