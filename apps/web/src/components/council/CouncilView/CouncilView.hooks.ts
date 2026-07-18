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
import type {
  CouncilConvergeDecision,
  CouncilPresetId,
  CouncilRoutingEdge,
  DebateTranscriptEntry,
} from '@/lib/bridge';
import {
  killCouncil,
  onDebateEvent,
  resolveCouncilConverge,
  setCouncilRouting,
  startCouncil,
} from '@/lib/bridge';

import type {
  ConvergePosition,
  CouncilPhase,
  CouncilRoutingControls,
  CouncilTranscript,
} from '../council.types';
import {
  convergeVerdictText,
  foldCouncilTranscript,
  hasConvergeDecision,
  hasConvergeVerdict,
} from '../council-transcript';
import { groupReplyRounds, type ReplyRound, STAGE_LABEL } from '../reply-diff';
import type { CouncilViewProps } from './CouncilView.types';

/** Every directed peer pair (`a → b`, a ≠ b) — the materialized OPEN routing graph.
 *  The first routing edit expands the implicit "everyone informs everyone" default into
 *  explicit edges so a single toggle can then constrain it. */
function directedPairs(seatIds: readonly string[]): CouncilRoutingEdge[] {
  const edges: CouncilRoutingEdge[] = [];
  for (const from of seatIds) {
    for (const to of seatIds) {
      if (from !== to) edges.push({ from, to });
    }
  }
  return edges;
}

/** Read-only replay affordance for a finished run (safety #7). */
export interface CouncilReplayControls {
  /** Whether replay can be offered — a finished run with a captured transcript. */
  available: boolean;
  /** Whether replay is currently showing (the board is swapped for the replay surface). */
  active: boolean;
  /** The finished run's append-only transcript to reconstruct. */
  transcript: DebateTranscriptEntry[];
  /** Enter replay (no-op unless `available`). */
  enter: () => void;
  /** Leave replay and return to the finished run's board. */
  exit: () => void;
}

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
  /** The broadcast rounds, side-by-side (Propose + each Debate round) — the reply diff. */
  replyRounds: ReplyRound[];
  /** The seats' final positions the human judges at Converge (one per seat). */
  positions: ConvergePosition[];
  /** True while a run is live (drives the Kill affordance + the "live" badge). */
  isLive: boolean;
  /** The current stage of a LIVE run, for the "Live · …" pill (e.g. "Propose",
   *  "Debate · round 2"), or `null` when not running / no activity yet (GOV-6). */
  liveStage: string | null;
  /** True once the human judge has ruled and the run is closed (#353, safety #7). */
  resolved: boolean;
  /** The recorded human verdict text, shown read-only once `resolved`. */
  verdict: string | null;
  /** The editable routing controller (issue #371) — the canvas edges as a live policy. */
  routing: CouncilRoutingControls;
  /** Read-only transcript REPLAY of a finished run (safety #7). Bundled so the view can
   *  offer + drive replay without growing the model surface. */
  replay: CouncilReplayControls;
  /** Start a council over `objective` with the chosen `presetId` (a fresh run id is
   *  minted). The phase advances to `running` only once the dispatch RESOLVES, so a
   *  failed start leaves the panel mounted with its draft intact; it rejects so the
   *  panel can surface the error inline (GOV-5). */
  start: (objective: string, presetId: CouncilPresetId) => Promise<void>;
  /** Throw the running council's kill switch (safety #4). */
  kill: () => void;
  /** Resolve the parked Converge decision with the human judge's verdict (#353). The
   *  verdict routes through the Conductor onto the append-only transcript and streams
   *  back over `nc:debate`, closing the run. Rejects so the gavel can surface + retry. */
  resolve: (
    decision: CouncilConvergeDecision,
    options?: { seatId?: string; note?: string },
  ) => Promise<void>;
  /** Return to the idle start panel to convene another council. */
  reset: () => void;
}

export function useCouncilView(props: CouncilViewProps): CouncilViewModel {
  const toast = useToast();
  const [phase, setPhase] = useState<CouncilPhase>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [entries, setEntries] = useState<DebateTranscriptEntry[]>([]);
  const [replayActive, setReplayActive] = useState(false);
  // The run's routing graph (issue #371). `null` = the OPEN default (every seat informs
  // every other, matching the engine's empty-edges behavior); a non-null array is the
  // EXPLICIT graph the human materialized by editing. Web-authoritative for DISPLAY; every
  // edit is dispatched through the Conductor, which owns the effect (safety #1).
  const [routingEdges, setRoutingEdges] = useState<CouncilRoutingEdge[] | null>(null);

  // The active run id, read INSIDE the once-installed stream subscription without
  // re-installing it on every run change (the subscription is stable for the view).
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;
  // Mirror the routing edges + the run's seat ids so `toggleInformer` reads the freshest
  // values synchronously (like `runIdRef`), without re-creating the callback each edit.
  const routingEdgesRef = useRef<CouncilRoutingEdge[] | null>(null);
  routingEdgesRef.current = routingEdges;
  const seatIdsRef = useRef<string[]>([]);

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

  // Advance the phase off the append-only stream: a CONDUCTOR converge note parks the
  // decision (→ the gavel mounts); the HUMAN verdict note the gavel produces streams
  // back and closes the run (→ resolved). Both are pure reads of the transcript (#353).
  useEffect(() => {
    if (phase === 'running' && hasConvergeDecision(entries)) setPhase('converged');
    else if (phase === 'converged' && hasConvergeVerdict(entries)) setPhase('resolved');
  }, [entries, phase]);

  const start = useCallback(
    async (objective: string, presetId: CouncilPresetId) => {
      const trimmed = objective.trim();
      if (trimmed.length === 0) return;
      const id = crypto.randomUUID();
      setRunId(id);
      setEntries([]);
      setReplayActive(false);
      setRoutingEdges(null);
      try {
        // DEFER the running transition until the dispatch resolves (GOV-5): the start
        // panel stays mounted (with its typed draft) until we know the run took.
        await startCouncil(id, presetId, trimmed, props.projectPath);
        setPhase('running');
      } catch (error) {
        // The run never started — drop the minted id so the panel returns to a clean
        // idle with its draft preserved, and rethrow so the panel shows the inline
        // error (a toast is kept too — cheap belt-and-braces).
        setRunId(null);
        toast.error('Could not start the council', error);
        throw error;
      }
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

  const resolve = useCallback(
    async (
      decision: CouncilConvergeDecision,
      options?: { seatId?: string; note?: string },
    ) => {
      const id = runIdRef.current;
      if (id === null) return;
      try {
        await resolveCouncilConverge(id, decision, {
          seatId: options?.seatId ?? null,
          note: options?.note ?? null,
        });
      } catch (error) {
        // Surface both channels: a toast (like start/kill) and — by rethrowing — the
        // gavel's inline error so it re-enables for a retry. The recorded verdict is the
        // confirmation, arriving over `nc:debate`.
        toast.error('Could not record your verdict', error);
        throw error;
      }
    },
    [toast],
  );

  const reset = useCallback(() => {
    setRunId(null);
    setEntries([]);
    setReplayActive(false);
    setRoutingEdges(null);
    setPhase('idle');
  }, []);

  // Toggle the "fromSeatId informs toSeatId" edge and dispatch the rewire through the
  // Conductor (issue #371). Materializes the OPEN default to explicit edges on the first
  // edit, then adds/removes the one edge. The dispatch is a CONDUCTOR DIRECTIVE — it only
  // changes which mediated, quoted peers a seat hears next Debate round; it never writes
  // into a seat (safety #1). Reads the freshest edges + seat ids from refs.
  const toggleInformer = useCallback(
    (fromSeatId: string, toSeatId: string) => {
      const id = runIdRef.current;
      if (id === null) return;
      const current = routingEdgesRef.current ?? directedPairs(seatIdsRef.current);
      const exists = current.some(
        (edge) => edge.from === fromSeatId && edge.to === toSeatId,
      );
      const next = exists
        ? current.filter(
            (edge) => !(edge.from === fromSeatId && edge.to === toSeatId),
          )
        : [...current, { from: fromSeatId, to: toSeatId }];
      routingEdgesRef.current = next;
      setRoutingEdges(next);
      void setCouncilRouting(id, next).catch((error: unknown) => {
        toast.error('Could not update routing', error);
      });
    },
    [toast],
  );

  // Replay is offered only for a FINISHED run that captured a transcript — never mid-run
  // (a live run has no terminal record to reconstruct). Entering swaps the board for the
  // read-only replay surface; the transcript is the captured `nc:debate` entries.
  const replayAvailable =
    (phase === 'resolved' || phase === 'stopped') && entries.length > 0;
  const enterReplay = useCallback(() => setReplayActive(true), []);
  const exitReplay = useCallback(() => setReplayActive(false), []);

  const transcript = useMemo(() => foldCouncilTranscript(entries), [entries]);
  // Mirror the current seat ids so a routing edit can materialize the OPEN graph over the
  // seats the run actually has (they've all spoken in Propose by the time Debate routing
  // matters). Assigned after the fold, read synchronously by `toggleInformer`.
  seatIdsRef.current = transcript.seats.map((seat) => seat.seatId);
  const replyRounds = useMemo(() => groupReplyRounds(entries), [entries]);
  // The live stage label for the "Live · …" pill (GOV-6): the stage of the most recent
  // bus activity, upgraded to the Debate round label when the seats are mid-debate.
  const liveStage = useMemo<string | null>(() => {
    if (phase !== 'running') return null;
    const last = transcript.chat.at(-1);
    if (last === undefined) return null;
    if (last.stage === 'debate') {
      const debateRound = replyRounds.filter((round) => round.stage === 'debate').at(-1);
      if (debateRound !== undefined) return debateRound.label;
    }
    return STAGE_LABEL[last.stage];
  }, [phase, transcript.chat, replyRounds]);
  const verdict = useMemo(() => convergeVerdictText(entries), [entries]);
  const positions = useMemo<ConvergePosition[]>(
    () =>
      transcript.seats.map((seat) => ({
        seatId: seat.seatId,
        role: seat.role,
        content: seat.latestContent,
      })),
    [transcript.seats],
  );

  return {
    hasProject: props.projectPath !== null,
    projectName: props.projectName,
    phase,
    runId,
    transcript,
    replyRounds,
    positions,
    isLive: phase === 'running',
    liveStage,
    resolved: phase === 'resolved',
    verdict,
    routing: {
      // Editable only while the run is LIVE — an edit takes effect on the next Debate
      // round, so it is meaningless once the debate has settled (converged/stopped).
      editable: phase === 'running',
      open: routingEdges === null,
      informs: (fromSeatId: string, toSeatId: string) =>
        routingEdges === null
          ? fromSeatId !== toSeatId
          : routingEdges.some(
              (edge) => edge.from === fromSeatId && edge.to === toSeatId,
            ),
      toggle: toggleInformer,
    },
    replay: {
      available: replayAvailable,
      active: replayActive,
      transcript: entries,
      enter: enterReplay,
      exit: exitReplay,
    },
    start,
    kill,
    resolve,
    reset,
  };
}
