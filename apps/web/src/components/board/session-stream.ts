/** Folds the `nc:session` engine event stream into a renderable activity
 *  timeline — per-session (`foldSession`) and grouped per task (`foldTranscript`). */
import { decideAssistantDelta } from '@nightcore/session-fold';
import type { NcEvent } from '@/lib/bridge';

/** A contiguous assistant speaking turn — accumulated markdown for one stretch of
 *  text between tool calls. Partial deltas concatenate into one entry so the
 *  markdown stays contiguous and parseable; a tool use closes it. */
export interface TextEntry {
  kind: 'text';
  /** Stable per-entry id — drives the timeline's React key instead of the
   *  array index, so a growing turn keeps its identity and React reconciles in
   *  place rather than remounting every `<li>` on each delta. */
  id: number;
  markdown: string;
  /** True once the turn is sealed (a tool/subagent step followed, or the session
   *  ended). The open (growing) turn renders as plain text; only a closed turn is
   *  parsed through `marked`+`DOMPurify` — once — avoiding an O(n²) reparse. */
  closed: boolean;
}

/** A single tool invocation streamed mid-turn. */
export interface ToolEntry {
  kind: 'tool';
  id: number;
  toolName: string;
  /** The tool's invocation input — already on the `nc:session` wire.
   *  Rendered as a concise per-line summary (file path / pattern / command) in
   *  TaskDetail. Optional so transcript-reseeded lines without input still load. */
  input?: Record<string, unknown>;
}

/** A subagent / Task-tool step streamed via `task-updated`. The SDK emits
 *  these for spawned subagents (`Explore`, etc.), rendered as a distinct
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
  /** Monotonic id source for text entries (stable keys); never reused. */
  textSeq: number;
  /** Running tool-line count, maintained incrementally so the board's
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

/** Fold one engine event into the accumulated stream. Mirrors the CLI dedup
 *  behavior: append partial deltas to the trailing open text entry, suppress the final
 *  whole-message block when partials streamed, and close the text turn (so the
 *  next delta opens a fresh entry) on each tool use. Replaying a recorded event
 *  sequence in order rebuilds the identical timeline (reseed parity). */
export function foldSession(prev: SessionStream, event: NcEvent): SessionStream {
  switch (event.type) {
    case 'session-started':
    case 'session-ready':
      return { ...EMPTY_STREAM };
    case 'assistant-delta': {
      // The partial-dedup decision (append / open / suppress) + the
      // `streamedPartial` flag live in the shared, view-neutral core
      // (`@nightcore/session-fold`); this adapter just materializes the decision
      // into the timeline. The web "open turn" is the trailing UNSEALED text
      // entry (a closed turn was sealed by a prior tool/subagent step or session
      // end), so a closed turn forces a fresh entry rather than appending.
      const last = prev.entries[prev.entries.length - 1];
      const open = last !== undefined && last.kind === 'text' && !last.closed;
      const decision = decideAssistantDelta({
        partial: event.partial,
        streamedPartial: prev.streamedPartial,
        hasOpenTurn: open,
      });
      if (decision.action === 'suppress') return prev;
      if (decision.action === 'append' && open) {
        // Append in place to the open turn (keeping its object identity stable)
        // rather than re-concatenating the full markdown into a fresh entry and
        // copying the whole entries array on every delta — that made a long
        // streamed turn O(n²) in its token count. Mutating the open entry under
        // a fresh top-level object keeps per-delta work O(1) amortized (V8 ropes
        // the `+=`), preserves the stable per-entry id the React key relies on,
        // and still hands React a new stream/array reference so it re-renders.
        // The turn is sealed (closed) before any markdown parse, so no consumer
        // ever observes a half-built open entry as immutable.
        // NOTE: because this mutates in place (stable object identity), the
        // ActivityLog timeline memoizes rows on a `markdown` STRING SNAPSHOT, not
        // on `entry` identity — identity never changes as the turn grows. Keep
        // that snapshot prop if this in-place append stays.
        last.markdown += event.text;
        return { ...prev, streamedPartial: decision.streamedPartial, entries: prev.entries };
      }
      const id = prev.textSeq + 1;
      return {
        ...prev,
        streamedPartial: decision.streamedPartial,
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

/** Best-effort role of a session within a task's lifecycle. A task's transcript
 *  typically holds a `build` run, then a `verify` (reviewer) run, plus any
 *  `plan`/replan or extra runs. Classification is a display hint only — derived
 *  from the session prompt — and never affects folding. */
export type SessionPhase = 'build' | 'verify' | 'plan' | 'session';

/** One logical session inside a task's transcript: its metadata plus the
 *  per-session folded stream. Reuses `SessionStream`/`foldSession` unchanged so a
 *  single session folds exactly as before. */
export interface SessionGroup {
  /** 1-based ordinal of this session within the task. */
  index: number;
  /** SDK session UUID (from `session-ready`), or null until/if it arrives. */
  sdkSessionId: string | null;
  /** Model the session ran on (from `session-started`/`session-ready`). */
  model: string | null;
  /** The session's launch prompt (from `session-started`) — drives the phase
   *  classification and a short preview in the UI. */
  prompt: string | null;
  /** Best-effort lifecycle role (build / verify / plan / generic). */
  phase: SessionPhase;
  /** The folded activity for this session alone. */
  stream: SessionStream;
}

/** A task's full transcript, grouped by session. Replaces the single
 *  `SessionStream` per task so a reseeded multi-session JSONL keeps every
 *  session's activity instead of collapsing to the last one. */
export interface TaskTranscript {
  sessions: SessionGroup[];
  /** Aggregate tool-line count across all sessions (drives the Logs badge). */
  toolCount: number;
}

export const EMPTY_TRANSCRIPT: TaskTranscript = { sessions: [], toolCount: 0 };

/** Classify a session's role from its prompt. Pure, heuristic, never throws. */
function classifyPhase(prompt: string | null, priorCount: number): SessionPhase {
  const p = (prompt ?? '').toLowerCase();
  if (/review|verif/.test(p)) return 'verify';
  if (/\bplan\b/.test(p)) return 'plan';
  if (priorCount === 0) return 'build';
  return 'session';
}

function aggregateToolCount(sessions: SessionGroup[]): number {
  let n = 0;
  for (const s of sessions) n += s.stream.toolCount;
  return n;
}

function newGroup(
  priorCount: number,
  fields: Partial<Omit<SessionGroup, 'index' | 'stream' | 'phase'>> & {
    phase?: SessionPhase;
  },
): SessionGroup {
  return {
    index: priorCount + 1,
    sdkSessionId: fields.sdkSessionId ?? null,
    model: fields.model ?? null,
    prompt: fields.prompt ?? null,
    phase: fields.phase ?? classifyPhase(fields.prompt ?? null, priorCount),
    stream: { ...EMPTY_STREAM },
  };
}

/** Fold one engine event into the grouped transcript. Session boundaries
 *  (`session-started`/`session-ready`) START a new group instead of wiping the
 *  stream; every other event delegates to `foldSession` on the latest group. This
 *  is what keeps the in-progress build run visible alongside the later
 *  verification run. Replaying a recorded transcript reproduces the live grouping
 *  (reseed parity). */
export function foldTranscript(prev: TaskTranscript, event: NcEvent): TaskTranscript {
  switch (event.type) {
    case 'session-started': {
      const group = newGroup(prev.sessions.length, {
        model: event.model,
        prompt: event.prompt,
      });
      return { ...prev, sessions: [...prev.sessions, group] };
    }
    case 'session-ready': {
      const last = prev.sessions[prev.sessions.length - 1];
      // Enrich the fresh group opened by a preceding `session-started`; if none
      // (a `session-ready` without a paired start), open a new group instead.
      if (
        last !== undefined &&
        last.sdkSessionId === null &&
        last.stream.entries.length === 0
      ) {
        const sessions = prev.sessions.slice();
        sessions[sessions.length - 1] = {
          ...last,
          sdkSessionId: event.sdkSessionId,
          model: event.model ?? last.model,
        };
        return { ...prev, sessions };
      }
      const group = newGroup(prev.sessions.length, {
        sdkSessionId: event.sdkSessionId,
        model: event.model,
      });
      return { ...prev, sessions: [...prev.sessions, group] };
    }
    default: {
      const sessions = prev.sessions.slice();
      // Defensive: events before any session boundary open a default group so
      // their activity is never dropped.
      if (sessions.length === 0) sessions.push(newGroup(0, { phase: 'build' }));
      const lastIdx = sessions.length - 1;
      const last = sessions[lastIdx];
      if (last === undefined) return prev;
      const nextStream = foldSession(last.stream, event);
      if (nextStream === last.stream) return prev; // unknown / no-op event
      sessions[lastIdx] = { ...last, stream: nextStream };
      return { sessions, toolCount: aggregateToolCount(sessions) };
    }
  }
}
