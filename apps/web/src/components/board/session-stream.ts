import type { NcEvent } from '@/lib/bridge';

/** A contiguous assistant speaking turn — accumulated markdown for one stretch of
 *  text between tool calls. Partial deltas concatenate into one entry so the
 *  markdown stays contiguous and parseable; a tool use closes it. */
export interface TextEntry {
  kind: 'text';
  /** Stable per-entry id (C6) — drives the timeline's React key instead of the
   *  array index, so a growing turn keeps its identity and React reconciles in
   *  place rather than remounting every `<li>` on each delta. */
  id: number;
  markdown: string;
  /** True once the turn is sealed (a tool/subagent step followed, or the session
   *  ended). The open (growing) turn renders as plain text; only a closed turn is
   *  parsed through `marked`+`DOMPurify` — once — avoiding the O(n²) reparse the
   *  audit flagged (C6). */
  closed: boolean;
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

/** A subagent / Task-tool step streamed via `task-updated` (C3). The SDK emits
 *  these for spawned subagents (`Explore`, etc.); the board used to drop them,
 *  silently losing subagent activity from the transcript. Rendered as a distinct
 *  timeline line so a run's subagent work is visible. */
export interface TaskEntry {
  kind: 'task';
  id: number;
  /** The SDK task id this step belongs to (deduped + merged in-place). */
  taskId: string;
  /** Subagent type when the step is a Task-tool subagent (e.g. `Explore`). */
  subagentType?: string;
  /** Human description of what the subagent step is doing. */
  description?: string;
  /** Short progress/result summary, when the SDK provides one. */
  summary?: string;
  /** Latest known status of the step (`running` → `completed`/`failed`/…). */
  status?: string;
}

/** One chronological item in a run's activity timeline: an assistant text turn, a
 *  tool call, or a subagent (`task-updated`) step. Interleaving these in arrival
 *  order is what visually separates speaking turns (fixing the run-on blob) while
 *  keeping the stream ordered. */
export type TimelineEntry = TextEntry | ToolEntry | TaskEntry;

/** Assembled live output for a single task's run, derived from `nc:session`. */
export interface SessionStream {
  entries: TimelineEntry[];
  costUsd: number | null;
  error: string | null;
  /** Whether the active turn streamed partial deltas, so the final
   *  whole-message block (partial: false) can be suppressed. */
  streamedPartial: boolean;
  toolSeq: number;
  /** Monotonic id source for text entries (C6 stable keys); never reused. */
  textSeq: number;
  /** Running tool-line count, maintained incrementally (perf #6) so the board's
   *  Logs badge never re-filters every task's entries on each delta. */
  toolCount: number;
}

export const EMPTY_STREAM: SessionStream = {
  entries: [],
  costUsd: null,
  error: null,
  streamedPartial: false,
  toolSeq: 0,
  textSeq: 0,
  toolCount: 0,
};

/** Seal the trailing open text turn, if any (a tool/subagent step or the session
 *  end follows it). A closed turn is parsed through markdown exactly once. */
function closeOpenText(entries: TimelineEntry[]): TimelineEntry[] {
  const last = entries[entries.length - 1];
  if (last === undefined || last.kind !== 'text' || last.closed) return entries;
  const sealed: TextEntry = { ...last, closed: true };
  return [...entries.slice(0, -1), sealed];
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
      // Whole-message block: suppress when partials already streamed this turn
      // (the trailing open text entry already holds the full text).
      if (!event.partial && prev.streamedPartial) return prev;
      const last = prev.entries[prev.entries.length - 1];
      // Append to the trailing OPEN text turn; a closed turn (sealed by a prior
      // tool/subagent step or session end) starts a fresh entry with a new id.
      if (last !== undefined && last.kind === 'text' && !last.closed) {
        const updated: TextEntry = { ...last, markdown: last.markdown + event.text };
        return {
          ...prev,
          streamedPartial: event.partial || prev.streamedPartial,
          entries: [...prev.entries.slice(0, -1), updated],
        };
      }
      const id = prev.textSeq + 1;
      return {
        ...prev,
        streamedPartial: event.partial || prev.streamedPartial,
        textSeq: id,
        entries: [...prev.entries, { kind: 'text', id, markdown: event.text, closed: false }],
      };
    }
    case 'tool-use-requested': {
      const nextSeq = prev.toolSeq + 1;
      // A tool use CLOSES the current text turn: sealing it means the next delta
      // opens a fresh text entry — which is what separates two speaking turns.
      return {
        ...prev,
        streamedPartial: false,
        toolSeq: nextSeq,
        toolCount: prev.toolCount + 1,
        entries: [
          ...closeOpenText(prev.entries),
          { kind: 'tool', id: nextSeq, toolName: event.toolName, input: event.input },
        ],
      };
    }
    case 'task-updated': {
      // Ambient/housekeeping steps stay out of the inline transcript.
      if (event.ambient) return prev;
      // Merge successive updates for the same SDK task id in place (running →
      // completed) rather than appending a new line per patch.
      const idx = prev.entries.findIndex(
        (e) => e.kind === 'task' && e.taskId === event.taskId,
      );
      if (idx !== -1) {
        const existing = prev.entries[idx] as TaskEntry;
        const merged: TaskEntry = {
          ...existing,
          subagentType: event.subagentType ?? existing.subagentType,
          description: event.description ?? existing.description,
          summary: event.summary ?? existing.summary,
          status: event.status ?? existing.status,
        };
        const entries = prev.entries.slice();
        entries[idx] = merged;
        return { ...prev, entries };
      }
      const nextSeq = prev.toolSeq + 1;
      // A subagent step also closes the current text turn (like a tool use).
      return {
        ...prev,
        streamedPartial: false,
        toolSeq: nextSeq,
        entries: [
          ...closeOpenText(prev.entries),
          {
            kind: 'task',
            id: nextSeq,
            taskId: event.taskId,
            subagentType: event.subagentType,
            description: event.description,
            summary: event.summary,
            status: event.status,
          },
        ],
      };
    }
    case 'session-completed':
      // The run ended — seal the trailing turn so it renders parsed markdown.
      return { ...prev, costUsd: event.costUsd, entries: closeOpenText(prev.entries) };
    case 'session-failed':
      return { ...prev, error: `${event.reason}: ${event.message}` };
    default:
      // Unknown / again-future variants are tolerated, never thrown.
      return prev;
  }
}
