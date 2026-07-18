/**
 * The side-by-side reply diff (issue #353) — the N seat replies of each broadcast round
 * rendered as aligned columns so disagreement is LEGIBLE. Disagreement is the product,
 * not noise to collapse: replies are NEVER merged into one view. Each round is one row
 * of columns (one per responding seat) that scrolls horizontally in its own container
 * when a council has many seats, so the board never scrolls sideways.
 *
 * A pure READER of the folded transcript ({@link import('../reply-diff').groupReplyRounds}):
 * it renders the seats' own recorded replies and feeds nothing back into a prompt (the
 * conductor-mediated bus stays the sole cross-seat path — safety #1/#2). The final
 * round is flagged "Final positions" — the set the human judges at Converge (#353).
 */
import { AgentsIcon, Badge, EmptyState, LayersIcon, Markdown } from '@/components/ui';

import type { ReplyDiffProps } from './ReplyDiff.types';

export function ReplyDiff({ rounds }: ReplyDiffProps) {
  if (rounds.length === 0) {
    return (
      <EmptyState
        icon={<LayersIcon size={28} />}
        title="No replies to compare yet"
        description="Each broadcast's seat replies appear here side-by-side as the round resolves — disagreement is the point."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <p className="text-2xs text-muted-foreground">
        Each broadcast's replies, side-by-side. Disagreement is the product — the columns
        are never merged into one answer.
      </p>
      {rounds.map((round) => (
        <section
          key={round.broadcastId}
          aria-label={`${round.label} replies`}
          className="flex flex-col gap-2"
        >
          <header className="flex flex-wrap items-center gap-2">
            <span className="text-sm-flat font-medium capitalize text-foreground">
              {round.label}
            </span>
            {round.isFinal && <Badge tone="primary">Final positions</Badge>}
            <span
              className={`flex items-center gap-1 text-2xs ${
                round.diverged ? 'text-warning' : 'text-success/80'
              }`}
            >
              {round.diverged
                ? `${round.columns.length} distinct position${round.columns.length === 1 ? '' : 's'}`
                : 'Aligned — no disagreement'}
            </span>
          </header>
          <div className="overflow-x-auto">
            <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-3">
              {round.columns.map((column) => (
                <article
                  key={column.seq}
                  aria-label={`Seat ${column.seatId} reply`}
                  className={`flex min-h-[120px] flex-col rounded-xl border bg-card ${
                    round.isFinal ? 'border-primary/40' : 'border-border'
                  }`}
                >
                  <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <AgentsIcon size={13} className="text-primary" aria-hidden />
                    <span className="truncate text-xs-plus font-medium text-foreground">
                      {column.seatId}
                    </span>
                    <Badge tone="primary" className="ml-auto capitalize">
                      {column.role}
                    </Badge>
                  </header>
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                    <Markdown className="text-xs-plus text-foreground/90">
                      {column.content}
                    </Markdown>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
