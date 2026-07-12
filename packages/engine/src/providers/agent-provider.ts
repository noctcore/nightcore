/**
 * The neutral agent-provider seam (issue #18, Phase 1).
 *
 * `AgentProvider` is the ONE surface the supervisor ({@link SessionManager}) drives
 * to run a model: it constructs sessions, advertises a {@link ProviderCapabilities}
 * descriptor, and enforces the fail-closed autonomy invariant BEFORE a session is
 * built. `AgentSession` is the per-run handle the supervisor controls (run /
 * interrupt / setModel / setAutonomy / …). Both speak `NightcoreEvent` + contract
 * types only — no Claude Agent SDK type crosses this boundary, so a second provider
 * (Codex, Gemini, …) slots in behind the same seam with no `match provider` in
 * orchestration.
 *
 * Claude is one implementation (`providers/claude/ClaudeAgentProvider`); the SDK,
 * its vocabulary, and the kind-preset/permission-mode bridging all live inside that
 * directory. The issue's flat method list (startSession / interrupt / setModel /
 * setAutonomy / probeConfig / listModels / complete / preflight / capabilities) is
 * realized here across the two roles: the factory/descriptor/guard methods on
 * `AgentProvider`, the per-session controls on `AgentSession`. `complete()` (one-shot
 * text generation) is deferred to Phase 2 (the Rust oneshot path) — adding it now
 * would be untested dead surface with no caller, so it is intentionally omitted.
 */
import type {
  AutonomyLevel,
  EffortLevel,
  HarnessPolicy,
  McpServerEntry,
  ModelDescriptor,
  NightcoreEvent,
  PermissionDecision,
  PermissionMode,
  ProviderCapabilities,
  ProviderConfigSnapshot,
  QuestionAnswer,
  TaskKind,
  WireImage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

/** The typed engine-event sink a session emits through (the supervisor forwards it). */
export type SessionEventSink = (event: NightcoreEvent) => void;

/**
 * The provider-neutral inputs the supervisor hands a provider to start ONE run.
 * The supervisor resolves the plain `?? config default` knobs (model / effort / cwd
 * / turn+budget ceilings); the provider resolves everything else it owns — the kind
 * preset, the effective autonomy (`permissionModeOverride` ?? preset default ??
 * provider default), and the provider-config collaborators. Deliberately carries NO
 * SDK-shaped field (the structured-output format, tool allow/deny presets, etc. are
 * resolved inside the Claude provider from `kind`).
 */
export interface StartSessionParams {
  /** The supervisor's monotonic session id (correlates events back to the run). */
  sessionId: number;
  /** The initial user prompt. */
  prompt: string;
  /** Optional image attachments for the first user message. */
  images?: WireImage[];
  /** The resolved model id. */
  model: string;
  /** The reasoning effort, when the surface/config chose one. */
  effort?: EffortLevel;
  /** A per-command autonomy override, in the neutral wire vocabulary; absent ⇒ the
   *  kind preset's default, then the provider's configured default, applies. The
   *  Claude provider lowers it to an SDK permission mode at its boundary. */
  autonomyOverride?: AutonomyLevel;
  /** The run's working directory (worktree-isolated; the confinement root). */
  cwd: string;
  /** The task kind (selects the provider's persona/tool preset + result post-processing). */
  kind?: TaskKind;
  /** Max conversation turns before the run stops (autonomy ceiling). */
  maxTurns?: number;
  /** Max spend in USD before the run stops (autonomy ceiling). */
  maxBudgetUsd?: number;
  /** Resume a prior session by its provider session id. */
  resumeSessionId?: string;
  /** External MCP servers to inject for this run. */
  mcpServers?: McpServerEntry[];
  /** A trusted pre-flight context pack composed ahead of the persona. */
  appendContextPack?: string;
  /** The project's harness runtime policy (protected paths + Bash deny patterns). */
  harnessPolicy?: HarnessPolicy;
  /** Absolute path of the per-task flight-recorder ledger, when recording. */
  ledgerPath?: string;
  /** OPT-IN OS-level write containment (the compensating control when a provider
   *  lacks PreToolUse hooks — see {@link assertHooksInvariant}). */
  sandboxWrites?: boolean;
}

/**
 * The fail-closed autonomy check the supervisor runs before a session is built.
 * Carries the effective neutral {@link AutonomyLevel} the run would use plus whether
 * OS write containment is active; the provider applies {@link assertHooksInvariant}.
 */
export interface PreflightRequest {
  /** The effective autonomy ceiling the run would use (neutral vocabulary). */
  autonomy: AutonomyLevel;
  /** Whether OS-level write containment is active for the run. */
  osSandboxed: boolean;
  /** Explicit opt-in for a provider's uncontained danger-full-access posture. */
  uncontainedBypassOptIn?: boolean;
}

/**
 * A live (or transient probe) session handle. The supervisor owns the lifecycle;
 * every method speaks contract/wire types so the supervisor never touches an SDK
 * shape. A probe session (from {@link AgentProvider.createProbeSession}) exposes the
 * same surface but is only ever asked for `listModels()` / `probeConfig()` — it
 * never has `run()` driven.
 */
export interface AgentSession {
  /** The effective autonomy ceiling this session runs under (resolved by the
   *  provider from the override / kind preset / provider default). */
  readonly permissionMode: PermissionMode;
  /** Drive the run to a terminal state. Never rejects — failures surface as
   *  `session-failed` events (degrade, don't throw). */
  run(): Promise<void>;
  /** Stream additional user input into a running session. */
  streamInput(text: string): void;
  /** Abort the run's subprocess. */
  interrupt(): Promise<void>;
  /** Switch the live session's model. */
  setModel(model: string): Promise<void>;
  /** Set the live session's autonomy ceiling, in the neutral {@link AutonomyLevel}
   *  vocabulary the wire carries; the provider bridges it to its own primitive (for
   *  Claude, an SDK `setPermissionMode` control request). */
  setAutonomy(autonomy: AutonomyLevel): Promise<void>;
  /** Resolve a parked interactive permission request from a surface command. */
  approvePermission(requestId: string, decision: PermissionDecision): boolean;
  /** Resolve a parked AskUserQuestion dialog from a surface command. */
  answerQuestion(requestId: string, answer: QuestionAnswer): boolean;
  /** The models this provider currently offers, as wire descriptors. */
  listModels(): Promise<ModelDescriptor[]>;
  /** The provider's resolved configuration for a project, as a wire snapshot. */
  probeConfig(projectPath: string): Promise<ProviderConfigSnapshot>;
}

/**
 * One agent provider. Constructs sessions, advertises its capability descriptor,
 * and guards the fail-closed autonomy invariant. Constructed once and reused; a
 * config-driven factory selects the implementation (Phase 4).
 */
export interface AgentProvider {
  /** The capability descriptor this provider advertises (the UI + orchestration
   *  degrade from this, never from the provider id). */
  capabilities(): ProviderCapabilities;
  /** Fail-closed autonomy guard — throws {@link AutonomyNotPermittedError} when the
   *  requested autonomy would need PreToolUse confinement the provider can't supply
   *  and no OS sandbox compensates. `startSession` runs it internally; exposed so
   *  the seam is directly testable (the gate battery). */
  preflight(request: PreflightRequest): void;
  /** Construct a live session for one run. Runs {@link preflight} first, so a
   *  refused autonomy throws {@link AutonomyNotPermittedError} instead of silently
   *  dropping confinement. */
  startSession(
    params: StartSessionParams,
    emit: SessionEventSink,
    logger?: Logger,
  ): AgentSession;
  /** Construct a transient, input-less probe session (model list / provider-config
   *  inspection). It never runs a model turn. */
  createProbeSession(logger?: Logger): AgentSession;
}

/**
 * The autonomy ceilings that let the agent act WITHOUT a per-tool prompt — the ones
 * whose only containment is the PreToolUse gate (workspace confinement + the
 * deny/ask tiers, which hold even under bypass). If a provider can't run that gate
 * (no hooks) these ceilings are the dangerous ones.
 */
const ELEVATED_AUTONOMY: ReadonlySet<AutonomyLevel> = new Set([
  'bypass',
  'auto-accept',
]);

/**
 * Raised when a run is refused because its provider cannot enforce the PreToolUse
 * confinement its requested autonomy relies on. Never silently drop confinement —
 * refuse the run (or require the OS sandbox) instead. See the issue #18 degradation
 * table ("`supportsHooks: false` ⇒ fail-closed, non-negotiable").
 */
export class AutonomyNotPermittedError extends Error {
  constructor(
    readonly providerId: string,
    readonly autonomy: AutonomyLevel,
  ) {
    super(
      `Provider '${providerId}' cannot run at autonomy '${autonomy}': it does not ` +
        'support PreToolUse hooks, so workspace confinement and the deny/ask gate ' +
        "cannot be enforced. Choose 'ask' or 'plan', or enable OS write containment.",
    );
    this.name = 'AutonomyNotPermittedError';
  }
}

/**
 * THE security crux (issue #18). The PreToolUse gate — workspace confinement plus
 * the deny/ask tiers that hold even under `bypassPermissions` — exists ONLY because
 * the provider exposes hooks. So a provider that reports `supportsHooks: false`
 * cannot be allowed to run at an elevated autonomy (`bypass` / `auto-accept`) where
 * nothing else prompts per tool call: that would silently drop confinement. The only
 * escape is an OS-level sandbox (`osSandboxed`) that contains writes at the kernel.
 * Otherwise, REFUSE. Pure + exported so the gate battery can exercise every arm.
 */
export function assertHooksInvariant(
  capabilities: ProviderCapabilities,
  autonomy: AutonomyLevel,
  opts: { osSandboxed: boolean; uncontainedBypassOptIn?: boolean },
): void {
  if (
    autonomy === 'bypass' &&
    !capabilities.supportsHooks &&
    !opts.osSandboxed &&
    opts.uncontainedBypassOptIn !== true
  ) {
    throw new AutonomyNotPermittedError(capabilities.id, autonomy);
  }
  if (
    ELEVATED_AUTONOMY.has(autonomy) &&
    autonomy !== 'bypass' &&
    !capabilities.supportsHooks &&
    !opts.osSandboxed
  ) {
    throw new AutonomyNotPermittedError(capabilities.id, autonomy);
  }
}

/**
 * Raised when a run is refused because its provider cannot enforce this project's
 * Harness governance policy (protected paths / Bash-command deny tiers) or write
 * the flight-recorder audit ledger the task requested (issue #296). Mirrors {@link
 * AutonomyNotPermittedError}: never silently run governed/audited work ungoverned
 * or unaudited — refuse the run instead. A real, synchronous pre-execution
 * interception seam for Codex (`codex app-server`'s `execCommandApproval`/
 * `applyPatchApproval` RPCs) exists but wiring it is a separate, larger initiative
 * — see #304. Until that lands, this is the durable fail-closed answer.
 */
export class GovernanceNotSupportedError extends Error {
  constructor(
    readonly providerId: string,
    /** The Harness policy was armed for this run and the provider can't enforce it. */
    readonly missingHarnessPolicy: boolean,
    /** The ledger was requested for this run and the provider can't write it. */
    readonly missingLedger: boolean,
  ) {
    super(
      GovernanceNotSupportedError.buildMessage(
        providerId,
        missingHarnessPolicy,
        missingLedger,
      ),
    );
    this.name = 'GovernanceNotSupportedError';
  }

  private static buildMessage(
    providerId: string,
    missingHarnessPolicy: boolean,
    missingLedger: boolean,
  ): string {
    const gaps = [
      missingHarnessPolicy
        ? "enforce this project's Harness governance policy (protected paths / " +
          'command deny)'
        : null,
      missingLedger ? 'write the audit ledger' : null,
    ].filter((gap): gap is string => gap !== null);
    return (
      `Provider '${providerId}' cannot ${gaps.join(' or ')}. Switch to Claude for ` +
      'this run, or disarm the policy.'
    );
  }
}

/**
 * THE fail-closed governance preflight (issue #296). A project's Harness runtime
 * policy (protected paths + Bash-command deny tiers) and the flight-recorder audit
 * ledger both ride Claude's PreToolUse hook seam (`HookBus`) — a provider that
 * can't run that seam has no channel to enforce the policy or record ledger
 * entries. So when EITHER is requested for a run (`StartSessionParams.harnessPolicy`
 * present, meaning the Rust core resolved an ARMED policy — see
 * `store/harness_policy.rs`'s resolution semantics — or `ledgerPath` set) and the
 * resolved provider's capability says it can't honor it, REFUSE the run before a
 * session is constructed — never silently drop governance or the audit trail.
 * Driven entirely by the capability descriptor (never a provider-id check), so a
 * future provider that DOES support governance is never refused here, and a
 * degraded provider is caught even if it isn't named `codex`. Pure + exported so
 * the gate battery can exercise every arm, mirroring {@link assertHooksInvariant}.
 */
export function assertGovernanceInvariant(
  capabilities: ProviderCapabilities,
  params: Pick<StartSessionParams, 'harnessPolicy' | 'ledgerPath'>,
): void {
  const missingHarnessPolicy =
    params.harnessPolicy !== undefined && !capabilities.supportsHarnessPolicy;
  const missingLedger = params.ledgerPath !== undefined && !capabilities.supportsLedger;
  if (missingHarnessPolicy || missingLedger) {
    throw new GovernanceNotSupportedError(
      capabilities.id,
      missingHarnessPolicy,
      missingLedger,
    );
  }
}
