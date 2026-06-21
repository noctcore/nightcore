import type {
  EffortLevel,
  NightcoreEventOf,
  PermissionMode,
  SessionStatus,
} from '@nightcore/contracts';

/** A single rendered line in the transcript. The reducer appends these as the
 *  event stream flows; `StreamView` renders them top-to-bottom.
 *
 *  `user` is surface-local: the engine event stream never echoes the operator's
 *  own prompt, so the reducer appends it on submit (like `ui-set-mode`). `system`
 *  carries slash-command output (e.g. `/help`, `/doctor`) — a multi-line block
 *  rendered distinctly from chat turns. */
export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool-call'; id: string; toolName: string; input: string }
  | { kind: 'tool-result'; id: string; isError: boolean; content: string }
  | { kind: 'notice'; id: string; tone: NoticeTone; text: string }
  | { kind: 'system'; id: string; title: string; lines: SystemLine[] };

export type NoticeTone = 'info' | 'success' | 'error';

/** One line of a `system` block. `tone` colors a status glyph for /doctor checks;
 *  plain lines render as muted body text. */
export type SystemLine = {
  text: string;
  tone?: 'ok' | 'warn' | 'error' | 'muted';
};

/** A permission request awaiting the user's approve/deny decision. */
export type PendingPermission = NightcoreEventOf<'permission-required'>;

/** The whole view state the TUI renders, folded from the event stream. */
export interface SessionView {
  /** Nightcore session id of the live session, or null before one starts. */
  sessionId: number | null;
  model: string;
  /** Reasoning effort applied to the NEXT session. Effort has no live setter in
   *  the SDK, so a `/model` effort choice fixes it at the next `start-session`.
   *  null = let the model decide (adaptive). */
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  status: SessionStatus | 'idle';
  /** Running/terminal cost in USD, when the SDK has reported it. */
  costUsd: number | null;
  numTurns: number | null;
  transcript: TranscriptEntry[];
  /** The oldest unresolved permission request, or null. */
  pendingPermission: PendingPermission | null;
  /** Failure reason + message after a `session-failed`, else null. */
  failure: { reason: string; message: string } | null;
  /** Internal: whether the current assistant turn streamed partial deltas, so the
   *  whole-message duplicate block can be suppressed (mirrors the CLI). */
  streamedPartial: boolean;
  /** Internal: id of the assistant entry currently being appended to. */
  activeAssistantId: string | null;
}
