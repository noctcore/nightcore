/**
 * The Council canvas model (issue #352) — the single hook the {@link
 * import('./CouncilView').CouncilView} shell binds to. Owns the run lifecycle
 * (start / kill), accumulates the live `nc:debate` stream for the ACTIVE run, and
 * folds it into the seat nodes + team-chat the canvas renders.
 *
 * The canvas is a pure READER: `start` mints the run id + dispatches `start_council`,
 * `kill` throws the kill switch (safety #4), and the stream subscription only READS
 * entries — nothing here feeds text back into a seat prompt (the conductor-mediated,
 * quoted, injection-scanned bus stays the sole cross-seat path — safety #1/#2). The
 * broadcast/DM/steer controls the design calls for need a conductor human-input command
 * that is a follow-up slice; #353 adds the human Converge (judge/accept/reject).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import type { DebateTranscriptEntry } from '@/lib/bridge';
import { killCouncil, onDebateEvent, startCouncil } from '@/lib/bridge';

import type { CouncilPhase, CouncilTranscript } from '../council.types';
import { foldCouncilTranscript, hasConvergeDecision } from '../council-transcript';
import type { CouncilViewProps } from './CouncilView.types';

/** The only P1 preset (a `research` council of ≥2 distinct models). */
const COUNCIL_PRESET = 'research' as const;

/** The model the canvas shell renders from. */
export interface CouncilViewModel {
  /** Whether a project is active (a council debates over the active project's root). */
  hasProject: boolean;
  /** The active project's display name, for the header. */
  projectName: string | null;
  /** The canvas lifecycle phase (idle shows the start panel; the rest show the board). */
  phase: CouncilPhase;
  /** The active run id (the `nc:debate` correlation key), or `null` when idle. */
  runId: string | null;
  /** The folded transcript: seat nodes + the team-chat projection. */
  transcript: CouncilTranscript;
  /** True while a run is live (drives the Kill affordance + the "live" badge). */
  isLive: boolean;
  /** Start a council over `objective` (a fresh run id is minted). */
  start: (objective: string) => void;
  /** Throw the running council's kill switch (safety #4). */
  kill: () => void;
  /** Return to the idle start panel to convene another council. */
  reset: () => void;
}

export function useCouncilView(props: CouncilViewProps): CouncilViewModel {
  const toast = useToast();
  const [phase, setPhase] = useState<CouncilPhase>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<DebateTranscriptEntry[]>([]);

  // The active run id, read INSIDE the once-installed stream subscription without
  // re-installing it on every run change (the subscription is stable for the view).
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  // Subscribe ONCE to the live `nc:debate` stream and fold only the ACTIVE run's
  // entries (a foreign run's stream is dropped). The append-only transcript lives in
  // the engine; this is a read-only projection of it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const fn = await onDebateEvent((event) => {
        if (event.runId !== runIdRef.current) return;
        setEntries((prev) => [...prev, event.entry]);
      });
      if (disposed) fn();
      else unlisten = fn;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // A converge note parks the decision for the human judge — flip the phase so the
  // board shows "awaiting judge" (#353 wires the accept/reject gavel on top of this).
  useEffect(() => {
    if (phase === 'running' && hasConvergeDecision(entries)) setPhase('converged');
  }, [entries, phase]);

  const start = useCallback(
    (objective: string) => {
      const trimmed = objective.trim();
      if (trimmed.length === 0) return;
      const id = crypto.randomUUID();
      setRunId(id);
      setEntries([]);
      setPhase('running');
      void startCouncil(id, COUNCIL_PRESET, trimmed, props.projectPath).catch(
        (error: unknown) => {
          setPhase('idle');
          toast.error('Could not start the council', error);
        },
      );
    },
    [props.projectPath, toast],
  );

  const kill = useCallback(() => {
    const id = runIdRef.current;
    if (id === null) return;
    setPhase('stopped');
    void killCouncil(id).catch((error: unknown) => {
      toast.error('Could not stop the council', error);
    });
  }, [toast]);

  const reset = useCallback(() => {
    setRunId(null);
    setEntries([]);
    setPhase('idle');
  }, []);

  const transcript = useMemo(() => foldCouncilTranscript(entries), [entries]);

  return {
    hasProject: props.projectPath !== null,
    projectName: props.projectName,
    phase,
    runId,
    transcript,
    isLive: phase === 'running',
    start,
    kill,
    reset,
  };
}
