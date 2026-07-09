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
