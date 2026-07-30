/**
 * The config-driven engine provider factory (issue #18, Phase 4).
 *
 * The ONE place a provider id → {@link AgentProvider} implementation mapping lives on
 * the engine side, so the supervisor ({@link SessionManager}) and the rest of
 * orchestration never `match provider`. This is the engine analogue of the Rust
 * `provider::build_provider` factory: selection happens here, degradation happens
 * from each provider's {@link ProviderCapabilities} descriptor, and everything
 * downstream is provider-neutral.
 *
 * An unknown/unset provider resolves to Claude — the same fail-safe fallback the Rust
 * factory uses (never a silent wrong backend; the id is already shape-validated by
 * `ProviderIdSchema` and defaulted to `claude` in `ConfigSchema`).
 */
import fs from 'node:fs';

import type { Config } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { AgentProvider } from './agent-provider.js';
import { CLAUDE_PROVIDER_ID } from './claude/capabilities.js';
import { ClaudeAgentProvider } from './claude/claude-agent-provider.js';
import { CODEX_PROVIDER_ID } from './codex/capabilities.js';
import { CodexAgentProvider } from './codex/codex-agent-provider.js';
import { REPLAY_PROVIDER_ID } from './replay/capabilities.js';
import { ReplayAgentProvider } from './replay/replay-agent-provider.js';

/**
 * Opt-in switch for the E2E ladder's replay provider (issue #406): the path of a
 * directory of NDJSON transcripts. When set, EVERY session in this process is served
 * by {@link ReplayAgentProvider} instead of a real agent — no credential, no network,
 * no spend, a bit-for-bit reproducible event stream.
 *
 * It overrides `config.provider` and the per-session `providerId` on purpose. The
 * Rust core threads the user's configured provider down on every spawn
 * (`NIGHTCORE_PROVIDER`), so honoring that under a replay run would put the REAL
 * Claude provider back in the loop for exactly the runs the ladder is trying to keep
 * offline. One process is either replaying or it is not.
 */
export const REPLAY_TRANSCRIPT_DIR_ENV = 'NIGHTCORE_E2E_REPLAY';

/**
 * Build the replay provider when the ladder asked for it, else `undefined`.
 *
 * Fail-LOUD, never fail-open: a set-but-unusable path THROWS. The alternative —
 * degrading to the real provider — is the worst outcome available, because it would
 * turn a CI job that believes it is offline into one that quietly reaches for a live
 * account, and a ring that believes it replayed a fixture into one that replayed
 * nothing. An unset variable is the only silent path, and it is the production path.
 */
function replayProviderFromEnv(logger?: Logger): AgentProvider | undefined {
  const dir = process.env[REPLAY_TRANSCRIPT_DIR_ENV]?.trim();
  if (dir === undefined || dir.length === 0) return undefined;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(
      `${REPLAY_TRANSCRIPT_DIR_ENV} is set to '${dir}', which is not a readable ` +
        'directory. Point it at the transcript fixtures ' +
        '(apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures) or unset it.',
    );
  }
  // WARN, not info: a process running fake agents must say so loudly in the log a
  // human reads when a run "completed" without doing anything.
  logger?.warn(
    'E2E REPLAY MODE: every session in this process replays a checked-in transcript — no real agent will run',
    { transcripts: dir },
  );
  return new ReplayAgentProvider(dir, logger);
}

export interface ProviderRegistry {
  forSession(providerId?: string): AgentProvider;
  all(): AgentProvider[];
}

class StaticProviderRegistry implements ProviderRegistry {
  constructor(
    private readonly defaultProviderId: string,
    private readonly providers: Record<string, AgentProvider>,
  ) {}

  forSession(providerId?: string): AgentProvider {
    return (
      this.providers[providerId ?? this.defaultProviderId] ??
      this.providers[this.defaultProviderId] ??
      this.providers[CLAUDE_PROVIDER_ID] ??
      Object.values(this.providers)[0]!
    );
  }

  all(): AgentProvider[] {
    return Object.values(this.providers);
  }
}

/** Construct the agent provider named by `config.provider`. The single engine-side
 *  provider-selection point (issue #18): `codex` → the {@link CodexAgentProvider};
 *  everything else (including `claude`) → the {@link ClaudeAgentProvider}. Adding a
 *  provider is a new arm HERE plus its `providers/<id>/` implementation — never a
 *  branch in the supervisor. */
export function buildProvider(
  config: Config,
  opts: { apiKeyFallback: boolean },
  logger?: Logger,
): AgentProvider {
  // The ladder's replay provider preempts config selection entirely — see
  // REPLAY_TRANSCRIPT_DIR_ENV for why honoring `config.provider` under a replay run
  // would defeat the point.
  const replay = replayProviderFromEnv(logger);
  if (replay !== undefined) return replay;
  switch (config.provider) {
    case CODEX_PROVIDER_ID:
      return new CodexAgentProvider(logger);
    default:
      return new ClaudeAgentProvider(config, opts, logger);
  }
}

/** Build the multi-provider registry used by the sidecar process. A task's
 *  `providerId` selects a provider per session; absent/unknown falls back to the
 *  configured default, then Claude. */
export function buildProviderRegistry(
  config: Config,
  opts: { apiKeyFallback: boolean },
  logger?: Logger,
  overrides: Record<string, AgentProvider> = {},
): ProviderRegistry {
  // Replay mode replaces the WHOLE registry, not one entry: the Rust core threads the
  // user's configured provider id down on every spawn, so a registry that still held a
  // real provider would serve it to any session that named one — the one thing a
  // zero-credential, zero-spend CI ring must never do. Every lookup lands on replay.
  const replay = replayProviderFromEnv(logger);
  if (replay !== undefined) {
    return new StaticProviderRegistry(REPLAY_PROVIDER_ID, {
      [REPLAY_PROVIDER_ID]: replay,
    });
  }
  const providers: Record<string, AgentProvider> = {
    [CLAUDE_PROVIDER_ID]: new ClaudeAgentProvider(config, opts, logger),
    [CODEX_PROVIDER_ID]: new CodexAgentProvider(logger),
    ...overrides,
  };
  const defaultProviderId = providers[config.provider] !== undefined ? config.provider : CLAUDE_PROVIDER_ID;
  return new StaticProviderRegistry(defaultProviderId, providers);
}
