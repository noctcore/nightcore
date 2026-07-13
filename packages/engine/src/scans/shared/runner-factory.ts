/**
 * The per-pass runner-construction seam for {@link ScanManager} (extracted from
 * `./scan-manager.js` so the orchestrator file stays under its size ratchet).
 *
 * A scan drives each item's read-only pass through the minimal {@link ScanSessionRunner}
 * slice — run the loop to a terminal state, and interrupt it on cancel. Production
 * builds the real Claude {@link SessionRunner} via {@link defaultRunnerFactory}; tests
 * inject a fake factory, and Codex/future providers route via the ProviderRegistry
 * instead. Re-exported from `./scan-manager.js` so its public surface is unchanged.
 */
import type { NightcoreEvent } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  SessionRunner,
  type SessionRunnerConfig,
} from '../../providers/claude/session-runner.js';

/** The slice of `SessionRunner` the orchestrator drives: run the loop to a terminal
 *  state, and interrupt it on cancel. A factory returning this lets tests inject a
 *  fake runner without spawning the SDK. */
export interface ScanSessionRunner {
  run(): Promise<void>;
  interrupt(): Promise<void>;
}

/** Constructs the runner for one pass. For Claude (and tests) this is typically the
 *  real {@link SessionRunner}; for Codex and future providers the manager routes
 *  via the ProviderRegistry instead. Overridable in tests. */
export type ScanRunnerFactory = (
  config: SessionRunnerConfig,
  emit: (event: NightcoreEvent) => void,
  logger?: Logger,
) => ScanSessionRunner;

export const defaultRunnerFactory: ScanRunnerFactory = (config, emit, logger) =>
  new SessionRunner(config, emit, logger);
