import type {
  EffortLevel,
  NightcoreEvent,
  NightcoreEventOf,
  PermissionMode,
} from '@nightcore/contracts';
import { formatDuration, formatUsage } from './format.js';
import type {
  NoticeTone,
  SessionView,
  SystemLine,
  TaskView,
  TranscriptEntry,
} from './types.js';

/**
 * Actions the view reducer folds. Most are raw engine events forwarded straight
 * from the `SessionManager` subscription; the `ui-*` actions cover state the
 * event stream does not mirror — surface-local concerns the engine never echoes:
 *  - `ui-set-mode` / `ui-set-model`: defaults chosen before a session exists.
 *  - `ui-permission-resolved`: clears a request the moment the user answers it.
 *  - `ui-user-message`: echoes the operator's own prompt into the transcript.
 *  - `ui-system-message`: a slash-command output block (/help, /doctor, …).
 *  - `ui-clear`: wipe the transcript (the `/clear` command) keeping session state.
 */
export type ViewAction =
  | NightcoreEvent
  | { type: 'ui-set-mode'; mode: PermissionMode }
  | { type: 'ui-set-model'; model: string; effort: EffortLevel | null }
  | { type: 'ui-permission-resolved' }
  | { type: 'ui-user-message'; text: string }
  | { type: 'ui-system-message'; title: string; lines: SystemLine[] }
  | { type: 'ui-clear' };

export function initialView(
  model: string,
  permissionMode: SessionView['permissionMode'],
  effort: EffortLevel | null = null,
): SessionView {
  return {
    sessionId: null,
    model,
    effort,
    permissionMode,
    status: 'idle',
    costUsd: null,
    numTurns: null,
    durationMs: null,
    usage: null,
    slashCommands: [],
    skills: [],
    tasks: new Map(),
    transcript: [],
    pendingPermission: null,
    failure: null,
    streamedPartial: false,
    activeAssistantId: null,
  };
}

let entrySeq = 0;
function nextId(prefix: string): string {
  entrySeq += 1;
  return `${prefix}-${entrySeq}`;
}

function notice(tone: NoticeTone, text: string): TranscriptEntry {
  return { kind: 'notice', id: nextId('notice'), tone, text };
}

/**
 * Fold one engine event into the view. Pure: returns a new `SessionView` (new
 * array references where mutated) so React re-renders only on real change.
 *
 * The partial-dedup mirrors `apps/cli`: when a turn streams `partial` deltas we
 * append to one growing assistant entry; the trailing whole-message block for
 * that same turn (`partial: false`) is suppressed. A tool call ends the turn and
 * resets the streamed flag so the next turn's whole-message block prints if it
 * streams no partials.
 */
export function reduce(view: SessionView, event: ViewAction): SessionView {
  switch (event.type) {
    case 'task-updated':
      return upsertTask(view, event);

    case 'ui-set-mode':
      return { ...view, permissionMode: event.mode };

    case 'ui-set-model':
      return { ...view, model: event.model, effort: event.effort };

    case 'ui-user-message':
      return {
        ...view,
        // A new user turn ends any in-flight assistant block so the next
        // assistant delta starts a fresh entry under this prompt.
        streamedPartial: false,
        activeAssistantId: null,
        transcript: [
          ...view.transcript,
          {
            kind: 'user',
            id: nextId('user'),
            text: event.text,
            // Stamp the live session id when one exists (a follow-up turn). For
            // the FIRST turn of a new session the id isn't assigned yet — the
            // `session-started` case below back-fills it onto this same entry.
            ...(view.sessionId !== null ? { sessionId: view.sessionId } : {}),
          },
        ],
      };

    case 'ui-system-message':
      return {
        ...view,
        transcript: [
          ...view.transcript,
          {
            kind: 'system',
            id: nextId('system'),
            title: event.title,
            lines: event.lines,
          },
        ],
      };

    case 'ui-clear':
      return {
        ...view,
        transcript: [],
        streamedPartial: false,
        activeAssistantId: null,
      };

    case 'ui-permission-resolved':
      return {
        ...view,
        pendingPermission: null,
        status: view.status === 'awaiting-permission' ? 'running' : view.status,
      };

    case 'session-started':
      return {
        ...view,
        sessionId: event.sessionId,
        model: event.model,
        permissionMode: event.permissionMode,
        status: 'starting',
        costUsd: null,
        numTurns: null,
        durationMs: null,
        usage: null,
        // A fresh session starts with no tasks; drop any from a prior run.
        tasks: new Map(),
        failure: null,
        // Back-fill the id onto the just-echoed prompt so the session marker
        // reads ABOVE the user's text — no separate "started" notice needed.
        transcript: stampLastUser(view.transcript, event.sessionId),
      };

    case 'session-ready':
      return {
        ...view,
        model: event.model,
        status: 'running',
        // Fold the session's own command palette so autocomplete + /help know
        // the SDK-native commands (and skills) alongside the local registry.
        slashCommands: event.slashCommands,
        skills: event.skills,
      };

    case 'assistant-delta':
      return appendAssistant(view, event.text, event.partial);

    case 'tool-use-requested':
      return {
        ...view,
        streamedPartial: false,
        activeAssistantId: null,
        transcript: [
          ...view.transcript,
          {
            kind: 'tool-call',
            id: nextId('tool'),
            toolName: event.toolName,
            // Keep the raw input; `StreamView` formats it per-tool (path, diff,
            // command, …) rather than dumping JSON.
            input: event.input,
          },
        ],
      };

    case 'tool-result':
      return {
        ...view,
        transcript: [
          ...view.transcript,
          {
            kind: 'tool-result',
            id: nextId('result'),
            isError: event.isError,
            content: firstLine(event.content),
          },
        ],
      };

    case 'permission-required':
      return {
        ...view,
        status: 'awaiting-permission',
        // Hold only the oldest unresolved request; the engine serializes them.
        pendingPermission: view.pendingPermission ?? event,
      };

    // The TUI doesn't render the AskUserQuestion picker (the desktop board owns
    // that surface); show a notice so the run isn't a silent hang and the engine
    // settles the parked dialog as cancelled on teardown.
    case 'question-required':
      return {
        ...view,
        transcript: [
          ...view.transcript,
          notice(
            'info',
            `Claude asked a question (${event.questions
              .map((q) => q.header)
              .join(', ')}) — answer it from the desktop board.`,
          ),
        ],
      };

    case 'session-completed':
      return {
        ...view,
        status: 'completed',
        costUsd: event.costUsd,
        numTurns: event.numTurns,
        durationMs: event.durationMs,
        usage: event.usage ?? null,
        pendingPermission: null,
        transcript: [
          ...view.transcript,
          notice('success', completionSummary(event)),
        ],
      };

    case 'session-failed':
      return {
        ...view,
        status: 'failed',
        pendingPermission: null,
        failure: { reason: event.reason, message: event.message },
        transcript: [
          ...view.transcript,
          notice('error', `failed (${event.reason}): ${event.message}`),
        ],
      };

    case 'session-status':
      return { ...view, status: event.status };

    // RPC reply correlated by requestId — intercepted before the board, not view state.
    case 'query-result':
      return view;

    // Insight analysis events are owned by the desktop board's Insight view; the
    // TUI is not that surface, so it ignores them.
    case 'analysis-started':
    case 'analysis-category-started':
    case 'analysis-category-completed':
    case 'analysis-completed':
    case 'analysis-failed':
      return view;
  }
}

function appendAssistant(
  view: SessionView,
  text: string,
  partial: boolean,
): SessionView {
  if (partial) {
    const transcript = view.transcript.slice();
    const activeId = view.activeAssistantId;
    const idx =
      activeId === null
        ? -1
        : transcript.findIndex(
            (e) => e.kind === 'assistant' && e.id === activeId,
          );

    if (idx === -1) {
      const id = nextId('assistant');
      transcript.push({ kind: 'assistant', id, text });
      return {
        ...view,
        transcript,
        streamedPartial: true,
        activeAssistantId: id,
      };
    }

    const existing = transcript[idx] as Extract<
      TranscriptEntry,
      { kind: 'assistant' }
    >;
    transcript[idx] = { ...existing, text: existing.text + text };
    return { ...view, transcript, streamedPartial: true };
  }

  // Whole-message block: suppress if this turn already streamed partials.
  if (view.streamedPartial) return view;

  return {
    ...view,
    transcript: [
      ...view.transcript,
      { kind: 'assistant', id: nextId('assistant'), text },
    ],
    activeAssistantId: null,
  };
}

/**
 * Upsert a task into the view, keyed by `taskId` (never by index). A patch event
 * may carry only some fields (e.g. a later `status`-only update), so we merge over
 * the existing entry, preserving an earlier description/subagentType. A first-seen
 * task defaults to `pending`/empty until the event fills them in.
 *
 * Returns a NEW `Map` (and a new `view`) so React sees a referential change.
 */
function upsertTask(
  view: SessionView,
  event: NightcoreEventOf<'task-updated'>,
): SessionView {
  const tasks = new Map(view.tasks);
  const existing = tasks.get(event.taskId);
  const merged: TaskView = {
    taskId: event.taskId,
    status: event.status ?? existing?.status ?? 'pending',
    description: event.description ?? existing?.description ?? '',
    summary: event.summary ?? existing?.summary,
    subagentType: event.subagentType ?? existing?.subagentType,
    ambient: event.ambient,
  };
  tasks.set(event.taskId, merged);
  return { ...view, tasks };
}

/** The completion notice line: turns + cost, plus duration and tokens when the
 *  SDK reported them. Mirrors the header stats so both read consistently. */
function completionSummary(event: NightcoreEventOf<'session-completed'>): string {
  const parts = [
    `done — ${String(event.numTurns)} turn(s)`,
    `$${event.costUsd.toFixed(4)}`,
  ];
  if (event.durationMs > 0) parts.push(formatDuration(event.durationMs));
  if (event.usage) parts.push(formatUsage(event.usage));
  return parts.join(' · ');
}

/**
 * Stamp `sessionId` onto the most recent user entry that is still unlabeled.
 * Used when `session-started` fires right after the operator's prompt was echoed
 * for a brand-new session: at echo time the id wasn't assigned yet, so we set it
 * here so the session marker renders above that prompt. Returns a new array only
 * if a matching entry was found.
 */
function stampLastUser(
  transcript: TranscriptEntry[],
  sessionId: number,
): TranscriptEntry[] {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const entry = transcript[i];
    if (entry?.kind === 'user') {
      if (entry.sessionId !== undefined) return transcript;
      const next = transcript.slice();
      next[i] = { ...entry, sessionId };
      return next;
    }
  }
  return transcript;
}

function firstLine(content: string): string {
  const line = content.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
