import type { NcEvent } from '@/lib/bridge';

/** A contiguous assistant speaking turn — accumulated markdown for one stretch of
 *  text between tool calls. Partial deltas concatenate into one entry so the
 *  markdown stays contiguous and parseable; a tool use closes it. */
export interface TextEntry {
  kind: 'text';
  markdown: string;
}

/** A single tool invocation streamed mid-turn. */
export interface ToolEntry {
  kind: 'tool';
  id: number;
  toolName: string;
  /** The tool's invocation input (M4.7 §B) — already on the `nc:session` wire.
   *  Rendered as a concise per-line summary (file path / pattern / command) in
   *  TaskDetail. Optional so transcript-reseeded lines without input still load. */
  input?: Record<string, unknown>;
}

/** One chronological item in a run's activity timeline: an assistant text turn or
 *  a tool call. Interleaving these in arrival order is what visually separates
 *  speaking turns (fixing the run-on blob) while keeping the stream ordered. */
export type TimelineEntry = TextEntry | ToolEntry;

/** Assembled live output for a single task's run, derived from `nc:session`. */
export interface SessionStream {
  entries: TimelineEntry[];
  costUsd: number | null;
  error: string | null;
  /** Whether the active turn streamed partial deltas, so the final
   *  whole-message block (partial: false) can be suppressed. */
  streamedPartial: boolean;
  toolSeq: number;
}

export const EMPTY_STREAM: SessionStream = {
  entries: [],
  costUsd: null,
  error: null,
  streamedPartial: false,
  toolSeq: 0,
};

/** Append assistant text to the trailing open text entry, creating a fresh one if
 *  the last entry is a tool (or the list is empty). A tool use thus closes the
 *  current text turn — the next delta opens a new entry, which is exactly what
 *  separates two speaking turns split by a tool call. */
function appendText(entries: TimelineEntry[], text: string): TimelineEntry[] {
  const last = entries[entries.length - 1];
  if (last !== undefined && last.kind === 'text') {
    const updated: TextEntry = { kind: 'text', markdown: last.markdown + text };
    return [...entries.slice(0, -1), updated];
  }
  return [...entries, { kind: 'text', markdown: text }];
}

/** Fold one engine event into the accumulated stream. Mirrors M0's dedup:
 *  append partial deltas to the trailing open text entry, suppress the final
 *  whole-message block when partials streamed, and close the text turn (so the
 *  next delta opens a fresh entry) on each tool use. Replaying a recorded event
 *  sequence in order rebuilds the identical timeline (reseed parity). */
export function foldSession(prev: SessionStream, event: NcEvent): SessionStream {
  switch (event.type) {
    case 'session-started':
    case 'session-ready':
      return { ...EMPTY_STREAM };
    case 'assistant-delta': {
      if (event.partial) {
        return {
          ...prev,
          streamedPartial: true,
          entries: appendText(prev.entries, event.text),
        };
      }
      // Whole-message block: suppress when partials already streamed this turn
      // (the trailing open text entry already holds the full text).
      if (prev.streamedPartial) return prev;
      return { ...prev, entries: appendText(prev.entries, event.text) };
    }
    case 'tool-use-requested': {
      const nextSeq = prev.toolSeq + 1;
      // A tool use CLOSES the current text turn: pushing the tool entry means the
      // next delta's appendText sees a trailing tool and opens a fresh text entry.
      return {
        ...prev,
        streamedPartial: false,
        toolSeq: nextSeq,
        entries: [
          ...prev.entries,
          { kind: 'tool', id: nextSeq, toolName: event.toolName, input: event.input },
        ],
      };
    }
    case 'session-completed':
      return { ...prev, costUsd: event.costUsd };
    case 'session-failed':
      return { ...prev, error: `${event.reason}: ${event.message}` };
    default:
      return prev;
  }
}
