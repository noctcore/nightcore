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
import type { Config } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { AgentProvider } from './agent-provider.js';
import { CLAUDE_PROVIDER_ID } from './claude/capabilities.js';
import { ClaudeAgentProvider } from './claude/claude-agent-provider.js';
import { CODEX_PROVIDER_ID } from './codex/capabilities.js';
import { CodexAgentProvider } from './codex/codex-agent-provider.js';

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
  const providers: Record<string, AgentProvider> = {
    [CLAUDE_PROVIDER_ID]: new ClaudeAgentProvider(config, opts, logger),
    [CODEX_PROVIDER_ID]: new CodexAgentProvider(logger),
    ...overrides,
  };
  const defaultProviderId = providers[config.provider] !== undefined ? config.provider : CLAUDE_PROVIDER_ID;
  return new StaticProviderRegistry(defaultProviderId, providers);
}
