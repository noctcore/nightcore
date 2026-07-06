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
import { ClaudeAgentProvider } from './claude/claude-agent-provider.js';
import { CODEX_PROVIDER_ID } from './codex/capabilities.js';
import { CodexAgentProvider } from './codex/codex-agent-provider.js';

/** Construct the agent provider named by `config.provider`. The single engine-side
 *  provider-selection point (issue #18): `codex` → the degraded {@link
 *  CodexAgentProvider} spike; everything else (including `claude`) → the {@link
 *  ClaudeAgentProvider}. Adding a provider is a new arm HERE plus its
 *  `providers/<id>/` implementation — never a branch in the supervisor. */
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
