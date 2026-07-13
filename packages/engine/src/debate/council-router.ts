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
 * per-seat OS sandbox is #354.
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
  /** Parent logger (nullable so the supervisor passes its own `logger` directly). */
  logger: Logger | undefined;
}

export class CouncilRouter {
  private readonly council: CouncilManager;

  constructor(options: CouncilRouterOptions) {
    const { startSession, subscribe, emit, logger } = options;
    this.council = new CouncilManager({
      // The `nc:debate` emit seam (#352): every appended transcript entry becomes a
      // `debate-entry` `NightcoreEvent` tagged with its council-run id, so the canvas
      // filters a run's stream by `runId`. Nothing is fed BACK into a seat prompt — the
      // canvas is a pure reader of the moderated bus (the injection firewall, safety #1).
      emit: (councilRunId, entry) =>
        emit({ type: 'debate-entry', runId: councilRunId, entry }),
      seatDriver: new SessionSeatDriver({
        backend: {
          // Seats run as `research`-kind (read-mostly reasoning) sessions; the
          // per-seat OS sandbox + governance tier is issue #354.
          spawn: (params) =>
            startSession({
              type: 'start-session',
              prompt: params.prompt,
              kind: 'research',
              model: params.model,
              ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
            }),
          on: subscribe,
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
    this.council.kill(command.runId);
  }
}
