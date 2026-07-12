/**
 * The Claude provider's capability descriptor and the Claude-internal bridge between
 * the wire `PermissionMode` vocabulary and the neutral {@link AutonomyLevel}.
 *
 * These are the two things the issue #18 seam localizes to `providers/claude/`: the
 * truthful capability matrix the UI/orchestration degrade from, and the mapping of
 * SDK permission modes (`bypassPermissions` / `acceptEdits` / `default` / `plan`) —
 * which today leak into `settings/helpers.rs::sdk_permission_mode` and
 * `plan_approval.rs` — onto the promoted `bypass | auto-accept | ask | plan`
 * vocabulary. Phase 3 makes `AutonomyLevel` the wire vocabulary and this mapping the
 * only place the SDK modes survive.
 */
import type {
  AutonomyLevel,
  PermissionMode,
  ProviderCapabilities,
} from '@nightcore/contracts';

/** Stable identifier + label for the Claude provider. */
export const CLAUDE_PROVIDER_ID = 'claude';
export const CLAUDE_PROVIDER_LABEL = 'Claude';

/**
 * The truthful Claude capability matrix. Every flag is REQUIRED (a descriptor is
 * complete by design), and every value reflects what the Claude Agent SDK actually
 * exposes today: hooks (the PreToolUse confinement gate), MCP, plan mode, SDK-native
 * structured output, session resume, file checkpointing, AskUserQuestion, layered
 * setting sources, the `~/.claude` session store, per-model effort, and FULL cost
 * telemetry (dollars AND tokens). All four autonomy ceilings are supported.
 *
 * `supportsHarnessPolicy`/`supportsLedger` are both `true`: the Harness runtime
 * policy and the flight-recorder ledger both ride the SAME PreToolUse hook
 * (`HookBus`) as the confinement gate — see `session-runner.ts`/`hook-bus.ts`.
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  id: CLAUDE_PROVIDER_ID,
  label: CLAUDE_PROVIDER_LABEL,
  autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
  supportsHooks: true,
  providesOwnWriteContainment: false,
  supportsHarnessPolicy: true,
  supportsLedger: true,
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

/**
 * Map an SDK `PermissionMode` onto the neutral {@link AutonomyLevel} the capability
 * contract speaks. This is the Claude-internal bridge the issue calls for: the
 * autonomy invariant is evaluated in neutral terms, while the wire protocol still
 * carries permission-mode strings until Phase 3.
 *
 * The six wire modes collapse onto the four autonomy ceilings. `dontAsk` (the
 * unattended reviewer/verification mode) and `auto` both act WITHOUT a per-tool
 * prompt, so they map to `auto-accept` — the fail-closed choice, since that lands
 * them in the elevated set the hooks invariant guards (a no-hooks provider running
 * either would be refused unless OS-sandboxed). Exhaustive by design; a new mode
 * must decide its ceiling here.
 */
export function permissionModeToAutonomy(mode: PermissionMode): AutonomyLevel {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass';
    case 'acceptEdits':
    case 'dontAsk':
    case 'auto':
      return 'auto-accept';
    case 'plan':
      return 'plan';
    case 'default':
      return 'ask';
  }
}

/**
 * Map a neutral {@link AutonomyLevel} onto the SDK `PermissionMode` the Claude
 * runner drives. This is the Phase-3 wire-intake direction: the NDJSON protocol now
 * carries the neutral autonomy vocabulary, and this is the ONLY place it is lowered
 * back to an SDK permission-mode string — the inverse of {@link
 * permissionModeToAutonomy}, localized to `providers/claude/`.
 *
 * The four autonomy ceilings map to their canonical SDK modes: `bypass →
 * bypassPermissions`, `auto-accept → acceptEdits`, `ask → default`, `plan → plan`.
 * The SDK-only `dontAsk`/`auto` modes are unreachable from the neutral vocabulary
 * (the engine's own reviewer/scan paths still request them directly in SDK terms),
 * so they are deliberately not produced here. Exhaustive by design.
 */
export function autonomyToPermissionMode(autonomy: AutonomyLevel): PermissionMode {
  switch (autonomy) {
    case 'bypass':
      return 'bypassPermissions';
    case 'auto-accept':
      return 'acceptEdits';
    case 'ask':
      return 'default';
    case 'plan':
      return 'plan';
  }
}
