/**
 * The replay provider's capability descriptor — E2E ladder rings 2–3 (issue #406).
 *
 * The replay provider is the deterministic, offline agent the ladder runs against so
 * CI never needs a Claude/Codex credential, a network, or a budget. It executes
 * NOTHING: it replays a checked-in transcript (`e2e::transcript_replay`'s fixtures)
 * through the neutral {@link AgentProvider} seam, one recorded `NightcoreEvent` at a
 * time. It is registered ONLY when `NIGHTCORE_E2E_REPLAY` names a readable transcript
 * directory (see `provider-factory.ts`), so a production build that never sets it can
 * never resolve to this provider.
 *
 * The descriptor is truthful, not convenient:
 *  - `supportsHooks: false` — there is no PreToolUse gate here, because there is no
 *    tool call to gate. See {@link ReplayAgentProvider.preflight} for why that does
 *    NOT make the elevated-autonomy invariant a lie in this one case.
 *  - `providesOwnWriteContainment: true` — total, by construction: the only I/O the
 *    whole provider performs is ONE read of the transcript file named by
 *    `NIGHTCORE_E2E_REPLAY` (`transcript.ts`). It spawns no process, opens no socket,
 *    and never writes — there is no write to contain.
 *  - `costTelemetry: 'full'` — whatever the transcript recorded is replayed verbatim,
 *    including `costUsd`. The numbers are RECORDED, not incurred; no spend happens.
 *  - `supportsSessionResume: false` and friends — a transcript is a fixed recording;
 *    claiming resume/checkpointing would promise behavior nothing implements.
 *
 * CONTRACT-ONLY, like its sibling descriptors: no SDK import, no fs import.
 */
import type { ProviderCapabilities } from '@nightcore/contracts';

/** Stable identifier + label for the replay provider (mirrors the `providers/replay/`
 *  directory slug, exactly as `claude`/`codex` do). */
export const REPLAY_PROVIDER_ID = 'replay';
export const REPLAY_PROVIDER_LABEL = 'Replay (E2E)';

/**
 * The truthful replay capability matrix. Complete by design — every flag present —
 * so orchestration and the UI degrade from THIS descriptor, never from the provider
 * id (the same rule every other provider follows).
 */
export const REPLAY_CAPABILITIES: ProviderCapabilities = {
  id: REPLAY_PROVIDER_ID,
  label: REPLAY_PROVIDER_LABEL,
  autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
  supportsHooks: false,
  providesOwnWriteContainment: true,
  supportsHarnessPolicy: false,
  supportsLedger: false,
  supportsMcp: false,
  supportsPlanMode: false,
  supportsStructuredOutput: false,
  supportsSessionResume: false,
  supportsFileCheckpointing: false,
  supportsAskUserQuestion: false,
  supportsSettingSources: false,
  supportsSessionStore: false,
  supportsEffort: false,
  supportsMaxTurns: false,
  supportsMaxBudget: false,
  costTelemetry: 'full',
};
