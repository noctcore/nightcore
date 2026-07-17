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

import { createCouncilGauntletRunner } from './council-gauntlet.js';
import { CouncilManager } from './council-manager.js';
import { SessionBuildDriver } from './session-build-driver.js';
import { SessionSeatDriver } from './session-seat-driver.js';
import { WorktreeOpBroker } from './worktree-rpc.js';

/** The council command family this router owns — the SINGLE source of truth for both
 *  the {@link CouncilCommand} type and the {@link CouncilRouter.handles} membership
 *  check, so the two can never drift. `satisfies` pins every entry to a real type. */
const COUNCIL_COMMAND_TYPES = [
  'start-council',
  'kill-council',
  'resolve-council-converge',
  'set-council-routing',
  // The host → engine RESOLUTION of a `worktree-op-required` request (issue #383). It is
  // `requestId`-correlated, but routed through this council family because the run it
  // resolves is council-scoped (like `resolve-council-converge`), so it lands before the
  // supervisor's session-id dispatch.
  'resolve-worktree-op',
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
  /** The path-less, `councilRunId`-keyed worktree RPC to the Rust host (issue #383) — the
   *  ONE new cross-process seam. Its host replies arrive as `resolve-worktree-op` commands
   *  routed to {@link WorktreeOpBroker.resolve} in {@link dispatch}. */
  private readonly worktree: WorktreeOpBroker;
  private readonly logger: Logger | undefined;

  constructor(options: CouncilRouterOptions) {
    const { startSession, subscribe, emit, interruptSession, logger } = options;
    this.logger = logger;

    // The seat driver is constructed ONCE and shared: its read-only `runTurn` (SEAT_SESSION_
    // HARDENING — `plan` + sandbox) drives every debating seat, and its write-capable
    // `runWriterTurn` (BUILD_WRITER_HARDENING — `auto-accept` + sandbox) drives the SINGLE
    // elected writer through the SAME spawn/correlation machinery (issue #383, no second
    // session-spawn path).
    const seatDriver = new SessionSeatDriver({
      backend: {
        // Seats + the writer run as `research`-kind sessions; the driver stamps the posture
        // onto `params` (SEAT_SESSION_HARDENING for a debater, BUILD_WRITER_HARDENING for
        // the writer) and this thunk forwards it onto `start-session`, where the existing
        // per-session confinement machinery applies it (Seatbelt + the SDK permission mode +
        // the PreToolUse workspace-confinement gate, auto-scoped to `cwd`).
        spawn: (params) =>
          startSession({
            type: 'start-session',
            prompt: params.prompt,
            kind: 'research',
            model: params.model,
            autonomy: params.autonomy,
            sandboxWrites: params.sandboxWrites,
            // Council seat marker (issue #364): a seat/writer is driven here, INSIDE the
            // engine — never via the board's `start_session` command — so the Rust core
            // pushed no pending-launch FIFO slot for it. Marking the command makes the
            // supervisor echo `council: true` onto the `session-started`, so the reader
            // skips board-FIFO correlation for it (no desync warn, no mis-bind).
            council: true,
            ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
          }),
        on: subscribe,
        // PR #359 LOW-B: cancel an abandoned seat's provider session so it can't keep
        // spending after timeout/quorum/kill.
        cancel: (sessionId) => interruptSession(sessionId),
      },
      ...(logger !== undefined ? { logger: logger.child('council-seat') } : {}),
    });

    // The engine↔Rust worktree seam (issue #383): shared by the write-capable build driver
    // (allocate/commit) and the Converge gauntlet runner (the gate). Every worktree path is
    // DERIVED host-side from the `councilRunId` — the engine never sends one.
    this.worktree = new WorktreeOpBroker({
      emit,
      ...(logger !== undefined ? { logger: logger.child('council-worktree') } : {}),
    });

    // The write-capable single-writer Build driver (issue #383) — the FIRST time a council
    // WRITES. It allocates the isolated worktree over the seam, runs the elected writer
    // write-capable-but-sandboxed inside it, and commits the edits so the human can merge.
    // Injecting it (+ the gauntlet runner below) ACTIVATES the previously-dormant Build for
    // the build-capable presets (ui-bug #367, coding #368); `research` stays gate-less +
    // write-less because it declares no `build` stage / `objectiveGate`.
    const buildDriver = new SessionBuildDriver({
      broker: this.worktree,
      runWriter: (request) => seatDriver.runWriterTurn(request),
      ...(logger !== undefined ? { logger: logger.child('council-build') } : {}),
    });

    this.council = new CouncilManager({
      // The `nc:debate` emit seam (#352): every appended transcript entry becomes a
      // `debate-entry` `NightcoreEvent` tagged with its council-run id, so the canvas
      // filters a run's stream by `runId`. Nothing is fed BACK into a seat prompt — the
      // canvas is a pure reader of the moderated bus (the injection firewall, safety #1).
      emit: (councilRunId, entry) =>
        emit({ type: 'debate-entry', runId: councilRunId, entry }),
      seatDriver,
      buildDriver,
      // The objective gate's exec (issue #383, safety #6): a build-capable preset's Converge
      // runs the Structure-Lock gauntlet over the writer's worktree via the SAME seam — the
      // Rust host reuses the board's audited `run_from` (manifest from the TRUSTED project
      // root, checks in the worktree), so NO new exec sink is added. A RED verdict OVERRIDES
      // consensus. `objectiveGateForPreset` keeps this DATA-DRIVEN: `research` (no
      // `objectiveGate` marker) stays gate-less on the same runner.
      gauntletRunner: createCouncilGauntletRunner(this.worktree),
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
    if (command.type === 'set-council-routing') {
      // The editable canvas edges (issue #371). A CONDUCTOR DIRECTIVE, never a direct seat
      // write: the Conductor replaces the run's routing graph and records the change onto
      // the append-only transcript, which streams it back over `nc:debate` (the canvas
      // reflects it) — the injection firewall (safety #1) is untouched.
      this.council.setRouting(command.runId, command.edges);
      return;
    }
    if (command.type === 'resolve-worktree-op') {
      // The host's reply to a `worktree-op-required` request (issue #383): the Rust host
      // performed the op against a worktree path IT derived from the run id, and echoes the
      // result here. Resolve the awaiting build-driver / gauntlet call. A stale reply (its
      // request timed out or the run was killed) resolves nothing — logged, never thrown.
      const resolved = this.worktree.resolve(command.requestId, {
        ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
        ...(command.gauntletPassed !== undefined
          ? { gauntletPassed: command.gauntletPassed }
          : {}),
        ...(command.gauntletSummary !== undefined
          ? { gauntletSummary: command.gauntletSummary }
          : {}),
        ...(command.error !== undefined ? { error: command.error } : {}),
      });
      if (!resolved) {
        this.logger?.debug(
          'resolve-worktree-op for an unknown/expired request; dropping',
          { requestId: command.requestId },
        );
      }
      return;
    }
    this.council.kill(command.runId);
  }
}
