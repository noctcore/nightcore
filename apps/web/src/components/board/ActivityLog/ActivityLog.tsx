/** Grouped, per-session activity log for a task's run transcript. */
import { memo } from 'react';

import {
  ChevronDownIcon,
  LayersIcon,
  LogsIcon,
  Markdown,
  TerminalIcon,
} from '@/components/ui';
import { summarizeInput } from '@/lib/summarize';

import type { SessionGroup, SessionPhase, TimelineEntry } from '../session-stream';
import { formatCost, modelDisplayName } from '../status';
import { useCollapse, useStickToBottom } from './ActivityLog.hooks';
import type { ActivityLogProps } from './ActivityLog.types';

/** Display label for a session's lifecycle phase. A generic `session` falls back
 *  to `Run N` (handled at the call site, which knows the ordinal). */
const PHASE_LABEL: Record<SessionPhase, string> = {
  build: 'Build',
  verify: 'Verification',
  plan: 'Plan',
  session: 'Run',
};

/** The grouped activity log: one collapsible block per session in the task's
 *  transcript. Keeping every session means the in-progress build run stays
 *  visible alongside the later verification run (the old single-stream model
 *  wiped the build when the verification session started). */
export function ActivityLog({ sessions, isRunning }: ActivityLogProps) {
  // A monotone-ish signal that changes as the newest session grows — new entries
  // AND the trailing turn's in-place markdown appends — so the auto-follow effect
  // re-fires on every streamed delta, not just when a whole entry is added.
  const live = sessions[sessions.length - 1];
  const liveEntries = live?.stream.entries ?? [];
  const tail = liveEntries[liveEntries.length - 1];
  const scrollTick =
    sessions.length + liveEntries.length + (tail?.kind === 'text' ? tail.markdown.length : 0);
  const sentinelRef = useStickToBottom(scrollTick, isRunning);

  return (
    <section aria-label="Activity">
      <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <LogsIcon size={11} />
        {isRunning ? 'Live activity' : 'Activity'}
      </h3>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {isRunning
            ? 'Waiting for first token…'
            : 'No activity yet — run this task to stream its transcript.'}
        </p>
      ) : sessions.length === 1 ? (
        // A single session needs no collapsible chrome — render it inline.
        <TimelineBody
          entries={sessions[0]!.stream.entries}
          error={sessions[0]!.stream.error}
          isRunning={isRunning}
        />
      ) : (
        <div className="space-y-2">
          {sessions.map((session, i) => (
            <SessionLog
              key={`${session.index}-${session.sdkSessionId ?? 'live'}`}
              session={session}
              // The most recent session is the live / most-relevant one — open it
              // by default and collapse the earlier runs.
              defaultOpen={i === sessions.length - 1}
              isRunning={isRunning && i === sessions.length - 1}
            />
          ))}
        </div>
      )}

      {/* Zero-height tail sentinel: the auto-follow effect scrolls this into view
          so the newest streamed token stays visible without yanking a user who
          scrolled up to read history. */}
      <div ref={sentinelRef} aria-hidden="true" />
    </section>
  );
}

/** One collapsible session block within the activity log: a header summarizing
 *  the session (phase, model, tool count, cost) over the session's timeline. */
function SessionLog({
  session,
  defaultOpen,
  isRunning,
}: {
  session: SessionGroup;
  defaultOpen: boolean;
  isRunning: boolean;
}) {
  const { open, toggle } = useCollapse(defaultOpen);
  const { entries, error, costUsd, toolCount } = session.stream;
  const label = session.phase === 'session' ? `Run ${session.index}` : PHASE_LABEL[session.phase];
  const meta = [
    session.model !== null ? modelDisplayName(session.model) : null,
    toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null,
    costUsd !== null ? formatCost(costUsd) : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TerminalIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/90">
          {label}
        </span>
        {isRunning && (
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
            Live
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
          {meta.join(' · ')}
        </span>
        <ChevronDownIcon
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div hidden={!open}>
        {open && (
          <div className="border-t border-border px-3 pb-3 pt-3">
            <TimelineBody entries={entries} error={error} isRunning={isRunning} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The header-less activity list for a single session: assistant text turns
 *  interleaved with boxed tool-call / subagent lines, in arrival order. The live
 *  cursor renders only on a trailing text entry; a terminal error replaces the
 *  list entirely. Shared by the inline single-session view and each collapsible
 *  `SessionLog`. */
function TimelineBody({
  entries,
  error,
  isRunning,
}: {
  entries: TimelineEntry[];
  error: string | null;
  isRunning: boolean;
}) {
  return (
    <>
      {error !== null ? (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/[0.12] px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </pre>
      ) : entries.length > 0 ? (
        <ol
          className="space-y-2.5"
          aria-live={isRunning ? 'polite' : undefined}
          aria-atomic={isRunning ? 'false' : undefined}
        >
          {entries.map((entry, i) => (
            // Cheap element creation only — the actual row render is memoized in
            // `TimelineEntryRow`, so a streaming flush re-renders just the single
            // growing trailing row instead of every prior entry (O(1), not O(N)).
            <TimelineEntryRow
              key={entryKey(entry)}
              entry={entry}
              // Snapshot the open turn's markdown into its own prop — see the
              // `markdown` prop doc on why identity memoization alone isn't enough.
              markdown={entry.kind === 'text' ? entry.markdown : ''}
              isLast={i === entries.length - 1}
              isRunning={isRunning}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isRunning ? 'Waiting for first token…' : 'No activity recorded for this session.'}
        </p>
      )}
    </>
  );
}

/** Stable React key for a timeline entry. A per-kind prefix disambiguates the
 *  numeric ids, which restart at 1 per kind — a text turn and a tool call can
 *  both be `id: 1`, so the prefix keeps their keys distinct within the list. */
function entryKey(entry: TimelineEntry): string {
  const prefix = entry.kind === 'text' ? 't' : entry.kind === 'task' ? 's' : 'x';
  return `${prefix}${entry.id}`;
}

/** Props for {@link TimelineEntryRow}. */
interface TimelineEntryRowProps {
  entry: TimelineEntry;
  /** Snapshot of a text turn's markdown (empty string for non-text entries).
   *  Passed as its own prop rather than read off `entry` because the open,
   *  still-streaming turn is mutated in place (`last.markdown += delta` in
   *  `foldSession`), so its object identity never changes as it grows. Memoizing
   *  on `entry` identity alone would freeze the live turn on screen; a string
   *  snapshot turns each delta into a real prop change, so `memo` re-renders only
   *  this one growing row and skips every sealed entry above it. */
  markdown: string;
  /** Whether this is the trailing entry — gates the streaming cursor. */
  isLast: boolean;
  isRunning: boolean;
}

/** One timeline `<li>`: an assistant text turn, a tool call, or a subagent step.
 *  `memo`ized so a streaming flush re-renders only the single growing trailing
 *  row — every sealed entry above keeps a stable object identity (and a stable
 *  `markdown` snapshot), so its render, including the heavy `marked`+`DOMPurify`
 *  markdown parse, is skipped. This keeps per-frame streaming cost O(1) in the
 *  transcript length instead of O(N), which is what the longest runs paid. */
const TimelineEntryRow = memo(function TimelineEntryRow({
  entry,
  markdown,
  isLast,
  isRunning,
}: TimelineEntryRowProps) {
  if (entry.kind === 'text') {
    return (
      <li className="text-foreground">
        {entry.closed ? (
          // Closed turn: parse markdown once (the heavy marked+DOMPurify pass) —
          // it no longer changes, so no O(n²) reparse.
          <Markdown>{markdown}</Markdown>
        ) : (
          // Open (still-streaming) turn: render as plain text while it grows, so
          // each delta is a cheap text update, not a reparse.
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {markdown}
          </p>
        )}
        {isRunning && isLast && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block w-[2px] animate-[nc-pulse_1s_ease-in-out_infinite] align-text-bottom text-primary"
          >
            ▌
          </span>
        )}
      </li>
    );
  }
  if (entry.kind === 'task') {
    const label = entry.subagentType ?? 'Subagent';
    const detail = entry.summary ?? entry.description;
    return (
      <li className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/[0.06] px-2 py-1 font-mono text-xs text-info">
        <LayersIcon size={12} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">
          <span className="font-semibold">{label}</span>
          {entry.status !== undefined && (
            <span className="text-muted-foreground"> · {entry.status}</span>
          )}
          {detail !== undefined && detail.length > 0 && (
            <span className="text-muted-foreground"> · {detail}</span>
          )}
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-1.5 rounded-md border border-border bg-white/[0.02] px-2 py-1 font-mono text-xs text-primary/80">
      <TerminalIcon size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        <span className="font-semibold">{entry.toolName}</span>
        {entry.input !== undefined && (
          <span className="text-muted-foreground"> · {summarizeInput(entry.input)}</span>
        )}
      </span>
    </li>
  );
});
