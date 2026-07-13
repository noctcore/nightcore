/** The live-session chat composer (`send-input`): a small textarea + Send that
 *  streams a user message into a running task's session — the sanctioned
 *  human→running-agent path. Rendered in the pinned dock while the task's build
 *  session is live. With two or more live sessions it offers a LOUD broadcast toggle
 *  (amber when armed) that fans ONE message across every live session at once, the
 *  session-id analog of the terminal's PTY broadcast.
 *
 *  Submit mirrors the board's composer convention (QuestionPromptCard / NewTaskForm):
 *  Cmd/Ctrl+Enter from the field sends, with a `⌘↵` Kbd hint; Send is disabled while
 *  the draft is blank. The relay comes from `TaskActionsContext` (`onSendInput`); an
 *  unwired handler degrades the composer to nothing (parity with the dock's guard). */
import { BroadcastIcon, Button, Kbd } from '@/components/ui';

import { useTaskActions } from '../actions';
import { broadcastInput } from '../session-broadcast';
import { useSessionComposer } from './SessionComposer.hooks';
import type { SessionComposerProps } from './SessionComposer.types';

export function SessionComposer({ taskId, liveSessionIds }: SessionComposerProps) {
  const { onSendInput } = useTaskActions();
  const { text, setText, broadcast, setBroadcast } = useSessionComposer();
  const trimmed = text.trim();
  const canBroadcast = liveSessionIds.length > 1;
  // Derived against eligibility so a live-set that collapses to one auto-disarms the
  // fan-out — a broadcast can never fire at a single session it didn't mean to.
  const armed = broadcast && canBroadcast;
  const inputId = `session-composer-${taskId}`;

  const submit = () => {
    if (trimmed.length === 0 || onSendInput === undefined) return;
    broadcastInput(taskId, trimmed, armed, liveSessionIds, onSendInput);
    setText('');
  };

  // Degrade to nothing when the relay isn't wired (parity with the dock's guard).
  if (onSendInput === undefined) return null;

  return (
    <form
      aria-label="Message the running agent"
      className="shrink-0 border-t border-border bg-card px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label
        htmlFor={inputId}
        className="mb-1.5 block font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground"
      >
        Message the agent
      </label>
      <textarea
        id={inputId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Cmd/Ctrl+Enter submits (Send is also `type="submit"`), matching the board's
        // composer convention. The listener lives on the textarea (the only focusable
        // field) rather than the form, so it needs no a11y opt-out.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="Send a message into the running session…"
        className="w-full resize-none rounded-[10px] border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
      />

      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" disabled={trimmed.length === 0}>
          {armed ? `Send to ${liveSessionIds.length}` : 'Send'} <Kbd>⌘↵</Kbd>
        </Button>
        {canBroadcast && (
          <button
            type="button"
            aria-pressed={armed}
            aria-label={armed ? 'Broadcast on' : 'Broadcast off'}
            title={`Send this message to all ${liveSessionIds.length} live sessions at once`}
            onClick={() => setBroadcast((on) => !on)}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
              armed
                ? 'bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/70'
                : 'text-muted-foreground hover:bg-white/[0.08] hover:text-foreground'
            }`}
          >
            <BroadcastIcon size={13} aria-hidden />
            <span>{armed ? 'Broadcasting' : 'Broadcast'}</span>
            {armed && (
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            )}
          </button>
        )}
      </div>
    </form>
  );
}
