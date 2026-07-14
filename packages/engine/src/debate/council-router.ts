/**
 * The Council command router (issue #350) — the `runId`-keyed `start-council` /
 * `kill-council` family's dispatch collaborator, sibling to the {@link
 * import('../scans/scan-router.js').ScanRouter}. Split out of {@link
 * import('../session/session-manager.js').SessionManager} so the supervisor owns
 * interactive session lifecycle only and stays under its file-size ratchet — adding
 * or changing council dispatch touches this router, not the supervisor.
 *
 * Like the scan families, council commands are keyed by `runId` (not a session id)
 * and drive their own sessions: each seat turn is a one-shot session the {@link
 * SessionSeatDriver} spawns and collects through the `startSession` / `subscribe`
 * seams the supervisor hands in. This router is ALSO the `nc:debate` emit seam (the
 * canvas slice, #352): it wraps every appended transcript entry into a `debate-entry`
 * `NightcoreEvent` on the supervisor's `emit` sink, so the stream rides the same
 * engine → sidecar → Rust `reader.rs` path every other `nc:*` family uses. The
 * per-seat OS sandbox + governance tier (issue #354, safety #3) rides on the
 * `SessionSeatDriver`'s spawn params ({@link
 * import('./session-seat-driver.js').SEAT_SESSION_HARDENING}) — this router forwards
 * them onto the underlying `start-session` command, and wires the seat cancel seam
 * (`interruptSession`) so an abandoned seat stops spending provider-side (PR #359).
 */
import type { NightcoreEvent, SurfaceCommand } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { CouncilManager } from './council-manager.js';
import { SessionSeatDriver } from './session-seat-driver.js';

/** The council command family this router owns — the SINGLE source of truth for both
 *  the {@link CouncilCommand} type and the {@link CouncilRouter.handles} membership
 *  check, so the two can never drift. `satisfies` pins every entry to a real type. */
const COUNCIL_COMMAND_TYPES = [
  'start-council',
  'kill-council',
  'resolve-council-converge',
] as const satisfies readonly SurfaceCommand['type'][];

type CouncilCommandType = (typeof COUNCIL_COMMAND_TYPES)[number];

/** The council commands this router owns, narrowed from `SurfaceCommand`. */
export type CouncilCommand = Extract<SurfaceCommand, { type: CouncilCommandType }>;

const COUNCIL_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(COUNCIL_COMMAND_TYPES);

export interface CouncilRouterOptions {
  /** Start a one-shot seat session and return its monotonic id SYNCHRONOUSLY. */
  startSession: (
    command: Extract<SurfaceCommand, { type: 'start-session' }>,
  ) => number;
  /** Subscribe to the supervisor's engine event stream. */
  subscribe: (listener: (event: NightcoreEvent) => void) => () => void;
  /** Emit a `NightcoreEvent` onto the supervisor's event stream — the `nc:debate` wire
   *  point (#352). Every appended transcript entry becomes a `debate-entry` event. */
  emit: (event: NightcoreEvent) => void;
  /** Cancel a seat's underlying provider session by id (PR #359 LOW-B) — the supervisor
   *  interrupts the live session, so an abandoned seat (timed out / superseded by quorum
   *  / killed) stops spending provider-side. Best-effort; an unknown id is a no-op. */
  interruptSession: (sessionId: number) => void;
  /** Parent logger (nullable so the supervisor passes its own `logger` directly). */
  logger: Logger | undefined;
}

export class CouncilRouter {
  private readonly council: CouncilManager;

  constructor(options: CouncilRouterOptions) {
    const { startSession, subscribe, emit, interruptSession, logger } = options;
    this.council = new CouncilManager({
      // The `nc:debate` emit seam (#352): every appended transcript entry becomes a
      // `debate-entry` `NightcoreEvent` tagged with its council-run id, so the canvas
      // filters a run's stream by `runId`. Nothing is fed BACK into a seat prompt — the
      // canvas is a pure reader of the moderated bus (the injection firewall, safety #1).
      emit: (councilRunId, entry) =>
        emit({ type: 'debate-entry', runId: councilRunId, entry }),
      seatDriver: new SessionSeatDriver({
        backend: {
          // Seats run as `research`-kind (reasoning) sessions, forced OS-sandboxed +
          // governed at the read-only `plan` tier (safety #3): the driver stamps the
          // posture onto `params` from SEAT_SESSION_HARDENING and this thunk forwards it
          // onto the `start-session` command, where the existing per-session confinement
          // machinery applies it (Seatbelt + the SDK permission mode).
          spawn: (params) =>
            startSession({
              type: 'start-session',
              prompt: params.prompt,
              kind: 'research',
              model: params.model,
              autonomy: params.autonomy,
              sandboxWrites: params.sandboxWrites,
              // Council seat marker (issue #364): a seat is driven here, INSIDE the
              // engine — never via the board's `start_session` command — so the Rust
              // core pushed no pending-launch FIFO slot for it. Marking the command
              // makes the supervisor echo `council: true` onto the seat's
              // `session-started`, so the reader skips board-FIFO correlation for the
              // seat (no desync warn, no mis-bind of a concurrent board task).
              council: true,
              ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
            }),
          on: subscribe,
          // PR #359 LOW-B: cancel an abandoned seat's provider session so it can't keep
          // spending after timeout/quorum/kill.
          cancel: (sessionId) => interruptSession(sessionId),
        },
        ...(logger !== undefined ? { logger: logger.child('council-seat') } : {}),
      }),
      ...(logger !== undefined ? { logger: logger.child('council') } : {}),
    });
  }

  /** Whether `command` is a council command this router owns. */
  handles(command: SurfaceCommand): command is CouncilCommand {
    return COUNCIL_COMMAND_TYPE_SET.has(command.type);
  }

  /** Dispatch a council command. Assumes {@link handles} returned true. */
  dispatch(command: CouncilCommand): void {
    if (command.type === 'start-council') {
      this.council.start({
        councilRunId: command.runId,
        presetId: command.presetId,
        objective: command.objective,
        ...(command.projectPath !== undefined
          ? { cwd: command.projectPath }
          : {}),
      });
      return;
    }
    if (command.type === 'resolve-council-converge') {
      // The human judge's terminal Converge verdict (issue #353, safety #7). The
      // Conductor records it onto the append-only transcript, which streams the verdict
      // back over `nc:debate` — the surface's confirmation that the run closed.
      this.council.resolveConverge(command.runId, {
        kind: command.decision,
        ...(command.seatId !== undefined ? { seatId: command.seatId } : {}),
        ...(command.note !== undefined ? { note: command.note } : {}),
      });
      return;
    }
    this.council.kill(command.runId);
  }
}
