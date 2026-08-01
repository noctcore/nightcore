/**
 * Local form state for the {@link import('./HumanInputBar').HumanInputBar} (issue #361):
 * the drafted message, the addressing mode (broadcast-all / DM-one / steer-stage), the
 * DM recipient, which verb is in flight, and the dispatch error. Kept out of the component
 * body (no-state-in-body).
 *
 * The three verbs map to ONE mediated dispatch — the Conductor decides the audience from
 * `mode`; the surface never routes to a seat itself. Tracking the in-flight verb (not a
 * bare boolean) lets only the PRESSED button show busy while the others merely disable
 * (GOV-8), matching the ConvergeGavel.
 */
import { useCallback, useEffect, useState } from 'react';

import type { CouncilHumanInputMode } from '@/lib/bridge';

import type { HumanInputSend } from './HumanInputBar.types';

/** Separator for the primitive seat-list key the recipient effect is keyed on. A seat id
 *  is a preset identifier, so it can never contain a newline. */
const SEAT_KEY_SEPARATOR = '\n';

export interface HumanInputBarModel {
  /** The drafted message. Relayed QUOTED + injection-scanned, never as a raw instruction. */
  message: string;
  setMessage: (value: string) => void;
  /** Who the message is addressed to. `direct` reveals the seat picker. */
  mode: CouncilHumanInputMode;
  setMode: (mode: CouncilHumanInputMode) => void;
  /** The DM recipient (the first live seat by default), or `''` when no seat is live. */
  seatId: string;
  setSeatId: (seatId: string) => void;
  /** The verb currently being dispatched, or `null` when idle. */
  pending: CouncilHumanInputMode | null;
  /** True while any dispatch is in flight — disables the controls. */
  busy: boolean;
  /** The last dispatch failure, shown inline so the human can retry. */
  error: string | null;
  /** Whether the drafted message can be sent (non-empty, live, and a DM has a recipient). */
  canSend: boolean;
  /** Relay the draft with the current mode. Clears the draft on success. */
  send: () => void;
  /** Relay the draft as a `steer` — it also asks the Conductor to end the Debate stage. */
  steer: () => void;
}

export function useHumanInputBar(
  onSend: HumanInputSend,
  live: boolean,
  seatIds: readonly string[],
): HumanInputBarModel {
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<CouncilHumanInputMode>('broadcast');
  const [seatId, setSeatId] = useState('');
  const [pending, setPending] = useState<CouncilHumanInputMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  // Keep the DM recipient pointing at a seat that actually exists: seats appear as they
  // first speak, and a run reset empties the list. Defaulting here (not in the body) keeps
  // the picker addressable the moment a DM becomes possible. Keyed on a PRIMITIVE join, not
  // the array — the caller derives `seatIds` per render, so an identity dep would re-run
  // this effect on every render.
  const seatKey = seatIds.join(SEAT_KEY_SEPARATOR);
  useEffect(() => {
    const ids = seatKey === '' ? [] : seatKey.split(SEAT_KEY_SEPARATOR);
    setSeatId((current) =>
      current !== '' && ids.includes(current) ? current : (ids[0] ?? ''),
    );
  }, [seatKey]);

  const trimmed = message.trim();
  const canSend =
    live && trimmed.length > 0 && (mode !== 'direct' || seatId.length > 0);

  const dispatch = useCallback(
    async (verb: CouncilHumanInputMode, text: string, recipient: string) => {
      setPending(verb);
      setError(null);
      try {
        await onSend(verb, text, verb === 'direct' ? recipient : undefined);
        // The recorded, quoted delivery arriving over `nc:debate` is the confirmation, so
        // clear the draft only once the dispatch resolved.
        setMessage('');
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not relay your message.',
        );
      } finally {
        setPending(null);
      }
    },
    [onSend],
  );

  const send = useCallback(() => {
    if (!canSend || busy) return;
    void dispatch(mode, trimmed, seatId);
  }, [busy, canSend, dispatch, mode, seatId, trimmed]);

  const steer = useCallback(() => {
    if (!canSend || busy) return;
    void dispatch('steer', trimmed, seatId);
  }, [busy, canSend, dispatch, seatId, trimmed]);

  return {
    message,
    setMessage,
    mode,
    setMode,
    seatId,
    setSeatId,
    pending,
    busy,
    error,
    canSend,
    send,
    steer,
  };
}
