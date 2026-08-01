/** Bridge commands — Council (governed multi-agent debate, issue #352). Start / kill
 *  a run; the append-only transcript streams over `nc:debate` (see `onDebateEvent`).
 *  The canvas only READS that stream, and the ONE command that puts human text in front
 *  of a seat ({@link sendCouncilHumanInput}, issue #361) routes it through the Conductor's
 *  quoted, injection-scanned bus — `sendInput`/`streamInput` (the non-Council user↔agent
 *  chat path) is never used here, because it would hand the surface direct-to-seat write
 *  authority and deliver human prose as a raw instruction (safety #1/#2). */
import { tauriInvoke } from '../internal';
import type {
  CouncilConvergeDecision,
  CouncilHumanInputMode,
  CouncilPresetId,
  CouncilRoutingEdge,
} from '../types';

/** Start a governed Council debate run over the active project. Unlike the scan
 *  `start-*` families — where Rust assigns the `runId` — the web MINTS it here and
 *  passes it: it is the `nc:debate` correlation key the canvas filters a run's stream
 *  by. `objective` is the task the seats debate; `projectPath` is the working directory
 *  the seat sessions run in (omit ⇒ the engine process cwd). Fire-and-forget: the run
 *  and its transcript live in the engine, streamed back over `nc:debate`. No-ops
 *  outside Tauri (browser preview). */
export async function startCouncil(
  runId: string,
  presetId: CouncilPresetId,
  objective: string,
  projectPath?: string | null,
): Promise<void> {
  await tauriInvoke<void>(
    'start_council',
    { runId, presetId, objective, projectPath: projectPath ?? null },
    undefined,
  );
}

/** Throw a running Council's kill switch (safety non-negotiable #4 — never "run until
 *  they agree"). Best-effort + idempotent: a no-op for an unknown/finished run, or when
 *  the sidecar isn't up. No-ops outside Tauri (browser preview). */
export async function killCouncil(runId: string): Promise<void> {
  await tauriInvoke<void>('kill_council', { runId }, undefined);
}

/** Resolve a run's PARKED Converge decision with the human judge's verdict (issue #353,
 *  safety non-negotiable #7 — the human is the terminal authority in P1's HUMAN-only
 *  Converge). The verdict flows through the engine's Conductor (the sole bus writer),
 *  which records it onto the append-only transcript and closes the run; the recorded
 *  verdict streams back over `nc:debate`, so this is fire-and-forget — the transcript
 *  entry is the confirmation. `seatId` names the adopted seat for an `accept`; `note` is
 *  the ruling for a `judge` (or an optional reason for `accept`/`reject`). Best-effort +
 *  idempotent: a no-op for an unknown/already-resolved run. No-ops outside Tauri. */
export async function resolveCouncilConverge(
  runId: string,
  decision: CouncilConvergeDecision,
  options: { seatId?: string | null; note?: string | null } = {},
): Promise<void> {
  await tauriInvoke<void>(
    'resolve_council_converge',
    {
      runId,
      decision,
      seatId: options.seatId ?? null,
      note: options.note ?? null,
    },
    undefined,
  );
}

/** Rewire a live Council run's routing policy — the editable canvas edges (issue #371).
 *  A routing edge is "A informs B": which seats' outputs reach a recipient seat as its
 *  MEDIATED, quoted, injection-scanned peer context in the Debate stage. `edges` REPLACES
 *  the run's current edge set (an empty list restores the open default — every seat
 *  informs every other). This is a CONDUCTOR DIRECTIVE, never a direct seat write (safety
 *  #1): the engine's Conductor — the sole bus writer — applies it to the next Debate round
 *  and records the change onto the append-only transcript, streamed back over `nc:debate`.
 *  Fire-and-forget + idempotent: a no-op for an unknown/finished run, or outside Tauri
 *  (browser preview) — the recorded routing note is the confirmation. */
export async function setCouncilRouting(
  runId: string,
  edges: CouncilRoutingEdge[],
): Promise<void> {
  await tauriInvoke<void>('set_council_routing', { runId, edges }, undefined);
}

/** Relay the human's mid-debate message into a live council run (issue #361) — the
 *  broadcast-all / DM-one / steer-stage controls. A CONDUCTOR DIRECTIVE, never the
 *  `sendInput` path: the engine's Conductor — the sole bus writer — runs `message` through
 *  the SAME quoted + injection-scanned relay every cross-seat text takes, records the
 *  scanned delivery onto the append-only transcript, and stages the QUOTED rendering for
 *  the target seat(s)' next mediated turn. The seat receives the human's words as
 *  attributed, fenced DATA to weigh — never as an instruction (safety #1/#2).
 *
 *  `mode` picks the audience: `broadcast` = every live seat, `direct` = the seat `seatId`
 *  names, `steer` = every live seat plus a directive to end the Debate stage at its next
 *  checkpoint (a strict shortener — it can only reach Converge sooner, safety #4).
 *  Fire-and-forget + idempotent-ish: a no-op for an unknown/finished run, an empty message,
 *  or a `direct` message naming an unknown seat — the recorded quoted delivery arriving
 *  over `nc:debate` is the confirmation. No-ops outside Tauri (browser preview). */
export async function sendCouncilHumanInput(
  runId: string,
  mode: CouncilHumanInputMode,
  message: string,
  seatId?: string | null,
): Promise<void> {
  await tauriInvoke<void>(
    'send_council_human_input',
    { runId, mode, message, seatId: seatId ?? null },
    undefined,
  );
}
