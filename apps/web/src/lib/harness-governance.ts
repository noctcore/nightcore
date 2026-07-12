/** The provider/governance mismatch warning (#296): whether the active project's
 *  Harness policy is meaningfully ARMED, and the create-task-dialog copy for when
 *  the picked provider can't enforce it. Split out of `NewTaskForm.hooks.ts` (a
 *  `@/lib` seam, not a feature — reusable by any future provider/run-controls
 *  surface without a cross-feature import). */
import type { HarnessPolicyFile, ProviderCapabilities } from './bridge';

/** Mirrors the engine's `harnessPolicyHasRules` (`providers/agent-provider.ts`) so
 *  the UI warns on the EXACT signal the fail-closed preflight refuses on — a
 *  present-but-empty manifest (e.g. self-protection-only) doesn't count. Checks
 *  all 7 arrays the engine checks, including `allowExecSinks` (#308) — the policy
 *  editor has no controls for it, but a hand-edited manifest armed exclusively
 *  through it must still trip this signal, or the pre-Create banner silently
 *  misses a policy the engine will actually refuse to run under. */
export function harnessPolicyHasRules(policy: HarnessPolicyFile): boolean {
  return (
    policy.protectedPaths.length > 0 ||
    policy.denyBashPatterns.length > 0 ||
    policy.denyReadPaths.length > 0 ||
    policy.disallowedTools.length > 0 ||
    policy.allowTools.length > 0 ||
    policy.askTools.length > 0 ||
    policy.allowExecSinks.length > 0
  );
}

/**
 * The provider/governance mismatch warning for the create-task dialog: the active
 * project's Harness policy is ARMED (see {@link harnessPolicyHasRules}) AND the
 * resolved provider can't enforce it, so the engine's `assertGovernanceInvariant`
 * would REFUSE the run — a heads-up, not the enforcement (#304 tracks real
 * Codex-side enforcement). Ignores `supportsLedger`: the ledger path is set
 * unconditionally per project, never a refusal trigger. `null` capabilities fail
 * OPEN, mirroring `providerSupportsPlanGate`.
 */
export function governanceWarningFor(
  harnessPolicyArmed: boolean,
  capabilities: ProviderCapabilities | null,
): string | null {
  if (!harnessPolicyArmed || capabilities === null) return null;
  if (capabilities.supportsHarnessPolicy) return null;
  return (
    `${capabilities.label} cannot enforce this project's Harness governance policy ` +
    '(protected paths / command deny) — the run will be refused. Switch to a ' +
    'provider that supports governance, or disarm the policy.'
  );
}
