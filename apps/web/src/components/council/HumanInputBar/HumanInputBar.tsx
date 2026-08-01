/**
 * The conductor-mediated human-input bar (issue #361) — broadcast-all / DM-one /
 * steer-stage. The #352 canvas shipped this bar as a deliberately inert affordance; this
 * enables it against the new Conductor command rather than redesigning it.
 *
 * What it is NOT: a chat box into a seat. Nothing here calls `sendInput`/`streamInput` —
 * that path hands text to a running session's provider runner as a raw user turn, which
 * would give this surface direct-to-seat write authority (safety #1) and deliver human
 * prose as a bare instruction (safety #2). The bar only DISPATCHES the human's message to
 * the engine's Conductor, which relays it through the same quoted + injection-scanned bus
 * every cross-seat text uses and stages the QUOTED rendering for the target seat(s)' next
 * mediated turn. The confirmation is the recorded delivery arriving over `nc:debate`.
 *
 * Mirrors the ConvergeGavel's dock conventions: a bottom-docked panel, labelled controls,
 * ⌘/Ctrl+↵ to submit the primary verb, per-button busy (only the pressed verb), and an
 * inline error the human can retry from. Keeps a DISABLED affordance when no run is live.
 */
import {
  BroadcastIcon,
  Button,
  ChevronRightIcon,
  ConfirmHint,
} from '@/components/ui';

import { useHumanInputBar } from './HumanInputBar.hooks';
import type { HumanInputBarProps } from './HumanInputBar.types';

const MESSAGE_INPUT_ID = 'council-human-input';
const SEAT_SELECT_ID = 'council-human-input-seat';

export function HumanInputBar({ seatIds, onSend, live }: HumanInputBarProps) {
  const bar = useHumanInputBar(onSend, live, seatIds);

  // No live run ⇒ nothing to address. Keep the affordance visible (so the layout and the
  // capability read the same) but inert, exactly as the #352 slice rendered it.
  if (!live) {
    return (
      <div
        className="flex shrink-0 items-center gap-2 border-t border-border bg-card/40 px-4 py-2.5"
        aria-label="Message the council (no live council)"
      >
        <BroadcastIcon size={14} className="text-muted-foreground" aria-hidden />
        <span className="text-2xs text-muted-foreground">
          Convene a council to broadcast, message one seat, or steer the stage.
        </span>
        <Button variant="secondary" disabled className="ml-auto">
          Broadcast to all
        </Button>
      </div>
    );
  }

  return (
    <section
      aria-label="Message the council"
      className="flex shrink-0 flex-col gap-2 border-t border-border bg-card/40 px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <BroadcastIcon size={14} className="text-primary" aria-hidden />
        <span className="text-2xs text-muted-foreground">
          Relayed through the conductor as quoted, injection-scanned data — the seats weigh
          it, they never execute it.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <label
            htmlFor={MESSAGE_INPUT_ID}
            className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground"
          >
            Your message
          </label>
          <textarea
            id={MESSAGE_INPUT_ID}
            value={bar.message}
            disabled={bar.busy}
            onChange={(event) => bar.setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                bar.send();
              }
            }}
            rows={2}
            placeholder="e.g. “Both plans skip the rollback rehearsal — weigh that before you settle.”"
            className="w-full resize-none rounded-nc border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary disabled:opacity-50"
          />
        </div>

        <fieldset className="flex flex-col gap-1" disabled={bar.busy}>
          <legend className="mb-1 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
            Audience
          </legend>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs-plus text-foreground">
            <input
              type="radio"
              name="council-human-input-mode"
              value="broadcast"
              checked={bar.mode === 'broadcast'}
              onChange={() => bar.setMode('broadcast')}
              className="accent-primary"
            />
            All seats
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs-plus text-foreground">
            <input
              type="radio"
              name="council-human-input-mode"
              value="direct"
              checked={bar.mode === 'direct'}
              onChange={() => bar.setMode('direct')}
              className="accent-primary"
            />
            One seat
          </label>
        </fieldset>

        {bar.mode === 'direct' && (
          <div className="flex flex-col gap-1">
            <label
              htmlFor={SEAT_SELECT_ID}
              className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground"
            >
              Recipient
            </label>
            <select
              id={SEAT_SELECT_ID}
              value={bar.seatId}
              disabled={bar.busy || seatIds.length === 0}
              onChange={(event) => bar.setSeatId(event.target.value)}
              className="rounded-nc border border-border bg-black/20 px-2 py-1.5 text-xs-plus text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              {seatIds.length === 0 ? (
                <option value="">No seats yet</option>
              ) : (
                seatIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              )}
            </select>
          </div>
        )}
      </div>

      {bar.error !== null && (
        <p role="alert" className="text-xs-plus text-destructive">
          {bar.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          busy={bar.pending === bar.mode}
          onClick={bar.send}
          disabled={!bar.canSend || bar.busy}
        >
          {bar.mode === 'direct' ? 'Send to seat' : 'Broadcast to all'}
        </Button>
        {/* Steering ends the Debate stage at its next checkpoint and routes to Converge —
            a strict shortener (safety #4), so it needs no destructive confirmation. */}
        <Button
          variant="secondary"
          busy={bar.pending === 'steer'}
          onClick={bar.steer}
          disabled={!bar.canSend || bar.busy}
        >
          {bar.pending !== 'steer' && <ChevronRightIcon size={14} aria-hidden />}
          Steer &amp; converge
        </Button>
        <ConfirmHint>to send</ConfirmHint>
      </div>
    </section>
  );
}
