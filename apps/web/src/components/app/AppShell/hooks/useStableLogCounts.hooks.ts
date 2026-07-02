import { useMemo, useRef } from 'react';

import type { TaskTranscript } from '@/components/board';

/** Serialize the per-task tool counts to a stable key so identity tracks the
 *  count VALUES, not the streams object (which is a fresh map on every delta). */
function serializeCounts(streams: Record<string, TaskTranscript>): string {
  return Object.keys(streams)
    .sort()
    .map((id) => `${id}:${streams[id]?.toolCount ?? 0}`)
    .join('|');
}

/** The streamed log-line count per task (the running card's Logs badge), with a
 *  STABLE object identity that only changes when an actual tool count changes.
 *  `streams` is a new map on every `nc:session` delta — including text-only
 *  `assistant-delta` partials that never touch any `toolCount` — so memoizing the
 *  counts object on the streams reference would hand the memoized Board → Column →
 *  TaskCard tree a fresh `logCounts` prop on every token and defeat their memos.
 *  Keying on the serialized counts collapses that: a text delta leaves the key
 *  (and thus the returned object) untouched, so the card tree stops reconciling on
 *  text tokens and only the card whose tool count advanced re-renders. */
export function useStableLogCounts(
  streams: Record<string, TaskTranscript>,
): Record<string, number> {
  const key = serializeCounts(streams);
  // Hold the streams map alongside the key so the recompute reads the current map
  // without listing `streams` as a memo dep (which would change every delta).
  const latest = useRef(streams);
  latest.current = streams;

  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [id, transcript] of Object.entries(latest.current)) {
      counts[id] = transcript.toolCount;
    }
    return counts;
  }, [key]);
}
