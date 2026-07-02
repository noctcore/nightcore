/** The per-task SDK session-history list: past runs, transcripts, and the
 *  resume/rename/tag affordances. */
import {
  AlertIcon,
  BranchIcon,
  ChevronDownIcon,
  ClockIcon,
  EditIcon,
  Markdown,
  PlayIcon,
  TagIcon,
} from '@/components/ui';
import type { SessionInfo, SessionMessage } from '@/lib/bridge';

import {
  extractMessageText,
  formatTimestamp,
  LIVE_SESSION_DATA,
  sessionTitle,
  useRenameEditor,
  useSessionHistory,
  useSessionTranscript,
} from './SessionHistory.hooks';
import type { SessionHistoryProps } from './SessionHistory.types';

/** A single transcript message rendered for the expanded session view. Reuses the
 *  shared `<Markdown>` for assistant/user text; a pure tool-use turn (no text)
 *  shows a compact type label so the row isn't empty. */
function TranscriptMessage({ message }: { message: SessionMessage }) {
  const text = extractMessageText(message.message);
  const roleLabel = message.type === 'assistant' ? 'Assistant' : message.type === 'user' ? 'User' : 'System';
  return (
    <li className="border-l border-border pl-2.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {roleLabel}
      </span>
      {text.trim().length > 0 ? (
        <Markdown className="mt-0.5 text-sm text-foreground/90">{text}</Markdown>
      ) : (
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">(tool activity)</p>
      )}
    </li>
  );
}

/** The expanded transcript for one session row. */
function Transcript({ messages, loading }: { messages: SessionMessage[]; loading: boolean }) {
  if (loading) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading transcript…</p>;
  }
  if (messages.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No messages in this session’s transcript.
      </p>
    );
  }
  return (
    <ol className="space-y-2 px-3 py-2.5">
      {messages.map((message) => (
        <TranscriptMessage key={message.uuid} message={message} />
      ))}
    </ol>
  );
}

/** One session row: title + meta on the left, view/resume/rename/tag on the right,
 *  expanding to its transcript. An orphaned session (its worktree was pruned) is
 *  badged and its Resume is hidden — the transcript stays viewable. */
function SessionRow({
  session,
  isCurrent,
  expanded,
  canResume,
  renaming,
  draft,
  transcript,
  onToggle,
  onResume,
  onStartRename,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onTag,
}: {
  session: SessionInfo;
  isCurrent: boolean;
  expanded: boolean;
  canResume: boolean;
  renaming: boolean;
  draft: string;
  transcript: React.ReactNode;
  onToggle: () => void;
  onResume: () => void;
  onStartRename: () => void;
  onChangeRename: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTag: () => void;
}) {
  // Resume is offered only when the task can resume AND this session isn't orphaned
  // (its worktree is gone, so resuming would start fresh instead of reattaching).
  const resumable = canResume && !session.orphaned;
  return (
    <li className="rounded-md border border-border bg-white/[0.02]">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            size={13}
            aria-hidden="true"
            className={`shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="min-w-0 flex-1">
            {renaming ? (
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- focus the inline rename field the moment it opens (a deliberate, user-initiated action, not a page-load autofocus)
                autoFocus
                value={draft}
                aria-label="Session title"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChangeRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onCommitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancelRename();
                  }
                }}
                onBlur={onCommitRename}
                className="w-full rounded border border-primary bg-black/30 px-1.5 py-0.5 text-sm text-foreground outline-none"
              />
            ) : (
              <span className="block truncate text-sm text-foreground">
                {sessionTitle(session)}
              </span>
            )}
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
              {formatTimestamp(session.lastModified) !== '' && (
                <span className="inline-flex items-center gap-1">
                  <ClockIcon size={10} />
                  {formatTimestamp(session.lastModified)}
                </span>
              )}
              {session.gitBranch !== null && session.gitBranch !== undefined && (
                <span className="inline-flex items-center gap-1">
                  <BranchIcon size={10} />
                  {session.gitBranch}
                </span>
              )}
              {session.tag !== null && session.tag !== undefined && (
                <span className="inline-flex items-center gap-1 text-info">
                  <TagIcon size={10} />
                  {session.tag}
                </span>
              )}
              {isCurrent && <span className="text-primary">· last run</span>}
              {session.orphaned && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <AlertIcon size={10} />
                  orphaned (worktree pruned)
                </span>
              )}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Rename session"
            title="Rename session"
            onClick={onStartRename}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <EditIcon size={13} />
          </button>
          <button
            type="button"
            aria-label="Tag session"
            title="Tag session"
            onClick={onTag}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <TagIcon size={13} />
          </button>
          {resumable && (
            <button
              type="button"
              aria-label="Resume session"
              title="Resume this session (reattaches with prior context)"
              onClick={onResume}
              className="inline-flex items-center gap-1 rounded border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <PlayIcon size={11} />
              Resume
            </button>
          )}
        </div>
      </div>

      {expanded && <div className="border-t border-border">{transcript}</div>}
    </li>
  );
}

/** The per-task SDK session history: a list of past runs (title, time, branch, tag,
 *  orphaned badge), each expanding to its transcript, with Resume (live cwd only),
 *  Rename, and Tag affordances. Fetches on mount via the bridge (or an injected
 *  data seam for stories/tests). A thin shell — all state lives in the hooks. */
export function SessionHistory({
  taskId,
  currentSdkSessionId,
  canResume,
  onResume,
  onRename,
  onTag,
  data = LIVE_SESSION_DATA,
}: SessionHistoryProps) {
  const { sessions, loading, reload } = useSessionHistory(taskId, data);
  const transcript = useSessionTranscript(taskId, data);
  const rename = useRenameEditor();

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading session history…</p>;
  }
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No past sessions yet — run this task to record one.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {sessions.map((session) => {
        const commitRename = () => {
          const next = rename.draft.trim();
          rename.close();
          if (next.length > 0 && next !== sessionTitle(session)) {
            onRename(session.sdkSessionId, next);
            reload();
          }
        };
        return (
          <SessionRow
            key={session.sdkSessionId}
            session={session}
            isCurrent={session.sdkSessionId === currentSdkSessionId}
            expanded={transcript.expandedId === session.sdkSessionId}
            canResume={canResume}
            renaming={rename.editingId === session.sdkSessionId}
            draft={rename.draft}
            transcript={
              <Transcript
                messages={transcript.messages}
                loading={transcript.loading}
              />
            }
            onToggle={() => transcript.toggle(session.sdkSessionId)}
            onResume={() => onResume(taskId, session.sdkSessionId)}
            onStartRename={() => rename.open(session.sdkSessionId, sessionTitle(session))}
            onChangeRename={rename.change}
            onCommitRename={commitRename}
            onCancelRename={rename.close}
            onTag={() => {
              // Toggle a simple "keep" tag for now: set it when absent, clear it
              // when present. (A richer tag editor can replace this affordance.)
              const next = session.tag !== null && session.tag !== undefined ? null : 'keep';
              onTag(session.sdkSessionId, next);
              reload();
            }}
          />
        );
      })}
    </ul>
  );
}
