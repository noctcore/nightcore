/**
 * The Council run manager (issue #350) — the `councilRunId`-keyed lifecycle surface
 * the sidecar drives, sibling to the scan managers the {@link
 * import('../scans/scan-router.js').ScanRouter} owns.
 *
 * It is a THIN wrapper over the {@link Conductor}: it resolves a preset id to its
 * registered value, starts a run fire-and-forget (a crash degrades to a logged
 * `failed` result, never a rejected promise — like the SessionManager and the scan
 * managers), and relays a kill to the live run's governor. The Conductor owns the
 * actual state machine + the injection firewall + the budget/kill enforcement; this
 * class owns only start/kill dispatch and preset resolution.
 *
 * Every appended transcript entry is forwarded to the optional {@link
 * CouncilManagerDeps.emit} sink — the SINGLE point where the `nc:debate` stream is
 * wired in the canvas slice (#352). Until then the sink is unset (the transcript is
 * still fully captured in the append-only store and returned by the run result, so
 * the run stays auditable — safety #7), and no debate event crosses the sidecar
 * boundary.
 */
import type {
  CouncilPresetId,
  DebateTranscriptEntry,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { DebateBus } from './bus.js';
import { Conductor } from './conductor.js';
import type { SeatDriver } from './conductor-types.js';
import { resolveCouncilPreset } from './preset-registry.js';

export interface CouncilManagerDeps {
  /** The provider-neutral seat driver (session-backed in production, fake in tests). */
  readonly seatDriver: SeatDriver;
  /** The debate bus (owns the append-only transcript store). Defaults to a fresh one. */
  readonly bus?: DebateBus;
  /** Forward every appended transcript entry — the `nc:debate` wire point (#352).
   *  Absent ⇒ transcript entries stay in-engine (captured in the store + run result). */
  readonly emit?: (entry: DebateTranscriptEntry) => void;
  readonly logger?: Logger;
}

/** The inputs a `start-council` command carries. */
export interface StartCouncilInput {
  readonly councilRunId: string;
  readonly presetId: CouncilPresetId;
  readonly objective: string;
  /** The working directory seat sessions run in (the active project root). */
  readonly cwd?: string;
}

export class CouncilManager {
  private readonly conductor: Conductor;
  private readonly logger?: Logger;

  constructor(deps: CouncilManagerDeps) {
    this.logger = deps.logger;
    this.conductor = new Conductor({
      bus: deps.bus ?? new DebateBus(),
      seatDriver: deps.seatDriver,
      ...(deps.emit !== undefined ? { onEntry: deps.emit } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });
  }

  /** Start a council run. Fire-and-forget: the outcome is logged, never awaited by the
   *  caller (the surface streams progress). A duplicate id for a still-active run is
   *  ignored, mirroring the scan managers' `start` guard. */
  start(input: StartCouncilInput): void {
    if (this.conductor.isActive(input.councilRunId)) {
      this.logger?.debug('council run already active; ignoring start', {
        councilRunId: input.councilRunId,
      });
      return;
    }

    const preset = resolveCouncilPreset(input.presetId);
    void this.conductor
      .run({
        councilRunId: input.councilRunId,
        preset,
        objective: input.objective,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      })
      .then((result) => {
        this.logger?.info('council run finished', {
          councilRunId: result.councilRunId,
          status: result.status,
          rounds: result.usage.rounds,
          costUsd: result.usage.costUsd,
          ...(result.haltedBy !== undefined ? { haltedBy: result.haltedBy } : {}),
        });
      })
      .catch((error) => {
        // Conductor.run degrades-not-throws, so this is belt-and-braces.
        this.logger?.warn('council run rejected unexpectedly', {
          councilRunId: input.councilRunId,
          error,
        });
      });
  }

  /** Throw the kill switch for a running council (safety #4). No-op for an unknown id. */
  kill(councilRunId: string): void {
    if (!this.conductor.kill(councilRunId)) {
      this.logger?.debug('kill for unknown/finished council run ignored', {
        councilRunId,
      });
    }
  }
}
