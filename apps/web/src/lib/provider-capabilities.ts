import type { ProviderCapabilities, ProviderId } from '@nightcore/contracts';

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  id: 'claude',
  label: 'Claude',
  autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
  supportsHooks: true,
  providesOwnWriteContainment: false,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: true,
  supportsAskUserQuestion: true,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  costTelemetry: 'full',
};

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  id: 'codex',
  label: 'Codex',
  autonomyLevels: ['auto-accept', 'ask', 'plan'],
  supportsHooks: false,
  providesOwnWriteContainment: true,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: false,
  supportsAskUserQuestion: false,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  costTelemetry: 'tokens-only',
};

export function capabilitiesForProvider(
  providerId: ProviderId | null | undefined,
  fallback: ProviderCapabilities | null,
): ProviderCapabilities | null {
  switch (providerId) {
    case 'claude':
      return fallback?.id === 'claude' ? fallback : CLAUDE_CAPABILITIES;
    case 'codex':
      return CODEX_CAPABILITIES;
    default:
      return fallback;
  }
}
