/**
 * The scan-orchestration collaborator: owns the four batch-scan managers
 * (Insight / Harness / Scorecard / PR-review) and routes their `runId`-keyed
 * `start-*` / `cancel-*` command families to the right manager. Split out of
 * {@link SessionManager} so the session supervisor owns interactive session
 * lifecycle only — adding a scan family (or changing scan dispatch) touches this
 * router, not the supervisor.
 *
 * Every scan family is keyed by `runId` (not a session id), fans out its own
 * internal read-only passes, and emits its own `<family>-*` event stream through
 * the shared `emit` sink the constructor is handed.
 */
import type {
  Config,
  NightcoreEvent,
  SurfaceCommand,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { HarnessManager } from './harness/manager.js';
import { AnalysisManager } from './insight/manager.js';
import { PrReviewScanManager } from './pr-review/manager.js';
import { ScorecardManager } from './scorecard/manager.js';

/** The scan command families this router owns — the `runId`-keyed `start-*` /
 *  `cancel-*` pairs, distinct from the session-id-keyed session commands. */
export type ScanCommand = Extract<
  SurfaceCommand,
  {
    type:
      | 'start-analysis'
      | 'cancel-analysis'
      | 'start-harness-scan'
      | 'cancel-harness-scan'
      | 'start-scorecard'
      | 'cancel-scorecard'
      | 'start-pr-review'
      | 'cancel-pr-review';
  }
>;

export interface ScanRouterOptions {
  config: Config;
  apiKeyFallback: boolean;
  /** The shared engine event sink — every scan manager emits through it. */
  emit: (event: NightcoreEvent) => void;
  /** Parent logger; each manager gets a named child (`analysis`, `harness`, …). */
  logger?: Logger;
}

export class ScanRouter {
  private readonly analysis: AnalysisManager;
  private readonly harness: HarnessManager;
  private readonly scorecard: ScorecardManager;
  private readonly prReview: PrReviewScanManager;

  constructor(options: ScanRouterOptions) {
    const { config, apiKeyFallback, emit, logger } = options;
    this.analysis = new AnalysisManager({
      config,
      apiKeyFallback,
      emit,
      ...(logger !== undefined ? { logger: logger.child('analysis') } : {}),
    });
    this.harness = new HarnessManager({
      config,
      apiKeyFallback,
      emit,
      ...(logger !== undefined ? { logger: logger.child('harness') } : {}),
    });
    this.scorecard = new ScorecardManager({
      config,
      apiKeyFallback,
      emit,
      ...(logger !== undefined ? { logger: logger.child('scorecard') } : {}),
    });
    this.prReview = new PrReviewScanManager({
      config,
      apiKeyFallback,
      emit,
      ...(logger !== undefined ? { logger: logger.child('pr-review') } : {}),
    });
  }

  /** Whether `command` belongs to a scan family this router owns. Narrows the type
   *  so the supervisor can delegate then return without a redundant re-check. */
  handles(command: SurfaceCommand): command is ScanCommand {
    switch (command.type) {
      case 'start-analysis':
      case 'cancel-analysis':
      case 'start-harness-scan':
      case 'cancel-harness-scan':
      case 'start-scorecard':
      case 'cancel-scorecard':
      case 'start-pr-review':
      case 'cancel-pr-review':
        return true;
      default:
        return false;
    }
  }

  /**
   * Route a scan command to its dedicated manager. Precondition: `handles(command)`
   * — the exhaustive switch mirrors the family list so the two can never drift.
   *
   * Insight analysis, Harness convention scans, the Readiness Scorecard, and PR
   * Review are each keyed by `runId` (not a session id): the owning manager fans
   * out its own read-only passes and emits its `<family>-*` event family.
   */
  dispatch(command: ScanCommand): void {
    switch (command.type) {
      case 'start-analysis':
        this.analysis.start(command);
        return;
      case 'cancel-analysis':
        this.analysis.cancel(command.runId);
        return;
      case 'start-harness-scan':
        this.harness.start(command);
        return;
      case 'cancel-harness-scan':
        this.harness.cancel(command.runId);
        return;
      case 'start-scorecard':
        this.scorecard.start(command);
        return;
      case 'cancel-scorecard':
        this.scorecard.cancel(command.runId);
        return;
      case 'start-pr-review':
        this.prReview.start(command);
        return;
      case 'cancel-pr-review':
        this.prReview.cancel(command.runId);
        return;
    }
  }
}
