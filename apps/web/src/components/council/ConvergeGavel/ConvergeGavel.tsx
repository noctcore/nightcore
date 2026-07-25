/**
 * The human Converge gavel (issue #353) — P1's Converge stage is HUMAN-only, so this is
 * the human's terminal authority over a council run (safety non-negotiable #7). The
 * human weighs the seats' final positions side-by-side (disagreement is the product) and
 * rules one of three ways: ACCEPT one seat's position, REJECT every position, or JUDGE
 * with their own ruling. The verdict flows through the Conductor (the sole bus writer)
 * onto the append-only transcript — never a direct store write from the surface (safety
 * #1); this component only DISPATCHES the human's choice and never feeds text into a
 * seat prompt.
 *
 * Mirrors the board's HITL dock conventions (plan approval / the verification gate): a
 * bottom-docked panel, labelled controls, ⌘/Ctrl+↵ to submit the primary action, and
 * sibling loading/empty/error affordances.
 */
import {
  Badge,
  Button,
  CheckIcon,
  CloseIcon,
  ConfirmDialog,
  ConfirmHint,
  Markdown,
  RefineIcon,
  VerifiedIcon,
} from '@/components/ui';

import { SEAT_ROLE_TONE } from '../council-roles';
import { useConvergeGavel } from './ConvergeGavel.hooks';
import type { ConvergeGavelProps } from './ConvergeGavel.types';

const RULING_INPUT_ID = 'council-converge-ruling';

export function ConvergeGavel({
  positions,
  onResolve,
  resolved = false,
  verdict,
}: ConvergeGavelProps) {
  const gavel = useConvergeGavel(onResolve);

  // Resolved: the run is closed — show the recorded verdict read-only, no actions.
  if (resolved) {
    return (
      <section
        aria-label="Converge verdict"
        className="shrink-0 border-t border-border bg-card/60 px-5 py-3"
      >
        <div className="flex items-center gap-2">
          <VerifiedIcon size={15} className="text-success" aria-hidden />
          <span className="text-sm-flat font-semibold text-foreground">
            Verdict recorded
          </span>
        </div>
        <p className="mt-1 text-xs-plus text-muted-foreground">
          {verdict ?? 'The human judge closed this council. The verdict is on the transcript.'}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Converge — your verdict"
      className="flex shrink-0 flex-col gap-3 border-t border-border bg-card/60 px-5 py-3"
    >
      <header className="flex items-center gap-2">
        <VerifiedIcon size={15} className="text-primary" aria-hidden />
        <h2 className="text-sm-flat font-semibold text-foreground">
          Converge — you're the judge
        </h2>
        <span className="text-2xs text-muted-foreground">
          Adopt a seat's position, write your own ruling, or reject them all. P1 Converge
          is yours alone.
        </span>
      </header>

      {positions.length === 0 ? (
        <p className="text-xs-plus text-muted-foreground">
          Waiting for the seats' final positions…
        </p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2" disabled={gavel.busy}>
            <legend className="mb-1 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
              Adopt a position
            </legend>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
              {positions.map((position) => {
                const selected = gavel.selectedSeatId === position.seatId;
                return (
                  <label
                    key={position.seatId}
                    className={`flex cursor-pointer flex-col gap-1 rounded-nc border px-3 py-2 transition-colors ${
                      selected
                        ? 'border-primary bg-primary/[0.06]'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="converge-position"
                        value={position.seatId}
                        checked={selected}
                        aria-label={`Adopt ${position.seatId}'s position`}
                        onChange={() => gavel.select(position.seatId)}
                        className="accent-primary"
                      />
                      <span className="truncate text-xs-plus font-medium text-foreground">
                        {position.seatId}
                      </span>
                      <Badge tone={SEAT_ROLE_TONE[position.role]} className="ml-auto capitalize">
                        {position.role}
                      </Badge>
                    </span>
                    <Markdown className="line-clamp-3 text-2xs text-muted-foreground">
                      {position.content}
                    </Markdown>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={RULING_INPUT_ID}
              className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground"
            >
              Your ruling / reason
            </label>
            <textarea
              id={RULING_INPUT_ID}
              value={gavel.note}
              disabled={gavel.busy}
              onChange={(event) => gavel.setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  gavel.submitPrimary();
                }
              }}
              rows={2}
              placeholder="Required to enter your own ruling; optional context when you accept or reject."
              className="w-full resize-none rounded-nc border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary disabled:opacity-50"
            />
          </div>

          {gavel.error !== null && (
            <p role="alert" className="text-xs-plus text-destructive">
              {gavel.error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              busy={gavel.pending === 'accept'}
              onClick={gavel.accept}
              disabled={!gavel.canAccept || gavel.busy}
            >
              {gavel.pending !== 'accept' && <CheckIcon size={14} aria-hidden />}
              {gavel.pending === 'accept' ? 'Recording…' : 'Accept selected'}
            </Button>
            <Button
              variant="secondary"
              busy={gavel.pending === 'judge'}
              onClick={gavel.judge}
              disabled={!gavel.canJudge || gavel.busy}
            >
              {gavel.pending !== 'judge' && <RefineIcon size={14} aria-hidden />}
              Enter my ruling
            </Button>
            <Button variant="danger" onClick={gavel.requestReject} disabled={gavel.busy}>
              <CloseIcon size={14} aria-hidden />
              Reject all
            </Button>
            <ConfirmHint>to submit</ConfirmHint>
          </div>

          {/* Rejecting closes the run for good, so it is guarded (GOV-9). */}
          <ConfirmDialog
            open={gavel.rejectConfirmOpen}
            title="Reject every position?"
            message="This permanently closes the council, rejecting every seat's position with no adopted outcome."
            confirmLabel="Reject and close"
            destructive
            busy={gavel.pending === 'reject'}
            onConfirm={gavel.confirmReject}
            onCancel={gavel.closeRejectConfirm}
          />
        </>
      )}
    </section>
  );
}
