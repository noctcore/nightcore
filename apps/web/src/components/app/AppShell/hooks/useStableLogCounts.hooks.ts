import { useRef } from 'react';

import type { TaskTranscript } from '@/components/board';

/** The streamed log-line count per task (the running card's Logs badge), with a
 *  STABLE object identity that only changes when an actual tool count changes.
 *  `streams` is a new map on every `nc:session` delta — including text-only
 *  `assistant-delta` partials that never touch any `toolCount` — so returning the
 *  counts derived off the streams reference would hand the memoized Board → Column
 *  → TaskCard tree a fresh `logCounts` prop on every token and defeat their memos.
 *
 *  Perf: this runs on the hot path (per RAF-coalesced flush while streaming). It
 *  diffs the incoming tool counts against the last returned object in a single
 *  O(n) pass — no sort, no string allocation — and returns the SAME object
 *  identity when nothing changed. A text-only delta leaves every count untouched,
 *  so the card tree stops reconciling on text tokens and only the card whose tool
 *  count advanced re-renders. */
export function useStableLogCounts(
  streams: Record<string, TaskTranscript>,
): Record<string, number> {
  const prev = useRef<Record<string, number>>({});
  const current = prev.current;

  // Single O(n) scan: detect whether the id set size or any tool count changed
  // vs. the previously returned object. The length check catches added/removed
  // ids; the per-id compare catches an advanced count (and an equal-size id swap,
  // since a newly-present id compares against `undefined`).
  const ids = Object.keys(streams);
  let changed = ids.length !== Object.keys(current).length;
  if (!changed) {
    for (const id of ids) {
      if ((streams[id]?.toolCount ?? 0) !== current[id]) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return current;

  const next: Record<string, number> = {};
  for (const id of ids) next[id] = streams[id]?.toolCount ?? 0;
  prev.current = next;
  return next;
}
