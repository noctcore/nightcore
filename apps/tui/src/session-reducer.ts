import type {
  EffortLevel,
  NightcoreEvent,
  PermissionMode,
} from '@nightcore/contracts';
import type {
  NoticeTone,
  SessionView,
  SystemLine,
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
          { kind: 'user', id: nextId('user'), text: event.text },
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
        failure: null,
        transcript: [
          ...view.transcript,
          notice('info', `session ${event.sessionId} started (${event.model})`),
        ],
      };

    case 'session-ready':
      return {
        ...view,
        model: event.model,
        status: 'running',
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
            input: compactJson(event.input),
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

    case 'session-completed':
      return {
        ...view,
        status: 'completed',
        costUsd: event.costUsd,
        numTurns: event.numTurns,
        pendingPermission: null,
        transcript: [
          ...view.transcript,
          notice(
            'success',
            `done — ${event.numTurns} turn(s), $${event.costUsd.toFixed(4)}`,
          ),
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

function compactJson(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

function firstLine(content: string): string {
  const line = content.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
