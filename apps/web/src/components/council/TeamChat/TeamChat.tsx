/**
 * The team-chat panel (issue #352) — a human-readable projection of the `nc:debate`
 * bus. Every entry the conductor recorded is shown in seq order: seat contributions,
 * conductor broadcasts + notes, and QUOTED inter-seat deliveries.
 *
 * A `delivery` entry is another seat's text relayed as DATA — already quoted +
 * injection-scanned by the conductor (safety #2). The panel surfaces that provenance
 * (the "quoted" tag + the scan result) but never treats it as an instruction, and never
 * feeds any of this back into a seat prompt — it is a read-only mirror of the bus.
 */
import { Badge, ChecksIcon, EmptyState, LogsIcon, Markdown } from '@/components/ui';
import type { DebateEntryKind } from '@/lib/bridge';

import type { TeamChatProps } from './TeamChat.types';

/** Human labels for each bus-write kind. */
const KIND_LABEL: Record<DebateEntryKind, string> = {
  broadcast: 'Broadcast',
  message: 'Message',
  delivery: 'Quoted',
  note: 'Note',
};

export function TeamChat({ chat }: TeamChatProps) {
  return (
    <aside
      aria-label="Team chat"
      className="flex w-[360px] shrink-0 flex-col border-l border-border bg-card/40"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <LogsIcon size={14} className="text-primary" aria-hidden />
        <h2 className="text-sm-flat font-semibold text-foreground">Team chat</h2>
        <span className="ml-auto text-2xs text-muted-foreground">
          {chat.length} {chat.length === 1 ? 'entry' : 'entries'}
        </span>
      </header>

      {chat.length === 0 ? (
        <EmptyState
          icon={<LogsIcon size={26} />}
          title="No messages yet"
          description="The debate transcript streams here — proposals, critiques, and the conductor's moderation."
        />
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
          {chat.map((entry) => (
            <li key={entry.seq} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs-plus font-medium text-foreground">
                  {entry.role === 'conductor' ? 'Conductor' : entry.seatId}
                </span>
                <Badge className="capitalize">{KIND_LABEL[entry.kind]}</Badge>
                <span className="text-2xs capitalize text-muted-foreground">
                  {entry.stage}
                </span>
                {entry.injectionFlags !== undefined && (
                  <span
                    className={`ml-auto flex items-center gap-1 text-2xs ${
                      entry.injectionFlags.length === 0
                        ? 'text-emerald-400/80'
                        : 'text-amber-400'
                    }`}
                    title={
                      entry.injectionFlags.length === 0
                        ? 'Relayed as quoted data — injection scan clean'
                        : `Injection scan flagged: ${entry.injectionFlags.join(', ')}`
                    }
                  >
                    <ChecksIcon size={12} aria-hidden />
                    {entry.injectionFlags.length === 0
                      ? 'scanned'
                      : `${entry.injectionFlags.length} flag${entry.injectionFlags.length === 1 ? '' : 's'}`}
                  </span>
                )}
              </div>
              <Markdown className="text-xs-plus text-foreground/90">
                {entry.content}
              </Markdown>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
