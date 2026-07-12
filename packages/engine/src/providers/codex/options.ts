import type {
  AutonomyLevel,
  EffortLevel,
  McpServerEntry,
  TaskKind,
} from '@nightcore/contracts';

import { toSdkMcpServers } from '../claude/session-options.js';
import type {
  ApprovalMode,
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  ThreadOptions,
} from './sdk-adapter.js';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

export interface CodexPosture {
  autonomy: AutonomyLevel;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  contained: boolean;
}

/** Process-level opt-in for the genuinely uncontained Codex posture. */
export const CODEX_BYPASS_OPT_IN_ENV = 'NIGHTCORE_CODEX_ALLOW_BYPASS';

export function codexBypassOptedIn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CODEX_BYPASS_OPT_IN_ENV] === '1';
}

/**
 * Map a neutral autonomy ceiling to a Codex sandbox + approval posture.
 *
 * THE DEADLOCK INVARIANT: the codex-sdk (`@openai/codex-sdk`) runs each turn as a
 * non-interactive `codex exec` — it writes the prompt to stdin, CLOSES stdin, and
 * exposes NO approval callback and no approval event in its `ThreadEvent` stream. So
 * any `approval_policy` that can raise an approval request (`on-request` /
 * `on-failure` / `untrusted`) has no channel to answer it: the run hangs (or at best
 * proceeds unverifiably). We therefore NEVER emit those policies here — every posture
 * uses `never`, which is provably fail-visible: a command the sandbox forbids simply
 * fails (surfaced as a failed `command_execution`), it is never escalated to an
 * unanswerable prompt. Write CONTAINMENT comes from the `sandboxMode`, not from an
 * approval prompt.
 */
export function codexPostureForAutonomy(
  autonomy: AutonomyLevel,
  opts: { bypassOptedIn: boolean },
): CodexPosture {
  switch (autonomy) {
    case 'plan':
      return {
        autonomy,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        contained: true,
      };
    case 'ask':
      // `ask` means "prompt me before acting", which Codex CANNOT honor (no approval
      // channel). It is removed from the advertised `autonomyLevels`, so it only
      // arrives here from a stale/persisted value or a global `permission_mode: "ask"`
      // a Codex task inherits. We degrade it to the SAFE read-only floor — NOT the
      // writable `workspace-write` posture — so the "prompt me first" safety
      // expectation is never silently dropped into autonomous writes. A build task
      // that lands here can't mutate the repo, which surfaces visibly (an empty diff),
      // never a silent escalation and never a hang.
      return {
        autonomy,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        contained: true,
      };
    case 'auto-accept':
      return {
        autonomy,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        contained: true,
      };
    case 'bypass':
      if (!opts.bypassOptedIn) {
        return {
          autonomy,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          contained: false,
        };
      }
      return {
        autonomy,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        contained: false,
      };
  }
}

/**
 * Task kinds pinned to a kernel read-only posture under Codex regardless of the
 * autonomy the run resolved to: the reviewer / verify identity (`review`) AND the
 * decompose proposer (`decompose`).
 *
 * WHY THIS EXISTS: Claude makes both kinds read-only via their KIND presets
 * (`disallowedTools: [WRITE_TOOLS…]` — the `review` preset also adds a `dontAsk`
 * permission mode; the `decompose` preset investigates read-only and only PROPOSES
 * sub-tasks, so it too denies `WRITE_TOOLS`). Codex has NO equivalent tool-surface
 * wiring — `buildCodexThreadOptions` derives its posture purely from the autonomy —
 * so a Codex reviewer OR decompose run would inherit whatever ceiling the run
 * resolved (e.g. the global `bypass`/`auto-accept` default) and could WRITE. We close
 * that by pinning these read-only KINDs to the `plan` posture (the codex kernel's
 * `read-only` sandbox), which is STRONGER than a tool denylist: the OS blocks the
 * write below the tool layer, so the run is provably unable to mutate the repo —
 * exactly mirroring Claude's `WRITE_TOOLS` denial for both kinds.
 */
const CODEX_READ_ONLY_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'review',
  'decompose',
]);

/** Whether a task kind must run read-only under Codex no matter the resolved
 *  autonomy (see {@link CODEX_READ_ONLY_KINDS}). */
export function codexKindForcesReadOnly(kind: TaskKind | undefined): boolean {
  return kind !== undefined && CODEX_READ_ONLY_KINDS.has(kind);
}

/**
 * The effective autonomy a Codex run uses. A read-only KIND (the reviewer OR the
 * decompose proposer — see {@link CODEX_READ_ONLY_KINDS}) is pinned to `plan` — the
 * read-only sandbox — so it can NEVER be handed a writable posture, whatever autonomy
 * was resolved for the task. Every other kind uses the requested autonomy, defaulting
 * to the safe read-only `plan` when none was set (`ask` is no longer a supported
 * ceiling — it would deadlock).
 */
export function codexEffectiveAutonomy(
  requested: AutonomyLevel | undefined,
  kind: TaskKind | undefined,
): AutonomyLevel {
  if (codexKindForcesReadOnly(kind)) return 'plan';
  return requested ?? 'plan';
}

export function effortToCodexEffort(
  effort: EffortLevel | undefined,
): ModelReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  return effort === 'max' ? 'xhigh' : effort;
}

export function buildCodexEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const next: Record<string, string> = {};
  if (env.PATH !== undefined) next.PATH = env.PATH;
  if (env.HOME !== undefined) next.HOME = env.HOME;
  if (env.SHELL !== undefined) next.SHELL = env.SHELL;
  if (env.CODEX_API_KEY !== undefined) next.CODEX_API_KEY = env.CODEX_API_KEY;
  return next;
}

export function buildCodexOptions(opts: {
  codexPathOverride?: string;
  mcpServers?: McpServerEntry[];
  env?: NodeJS.ProcessEnv;
}): CodexOptions {
  const mcpServers = toSdkMcpServers(opts.mcpServers);
  const config: CodexConfigObject = {};
  if (mcpServers !== undefined) {
    config.mcp_servers = mcpServers as CodexConfigObject;
  }
  return {
    ...(opts.codexPathOverride !== undefined
      ? { codexPathOverride: opts.codexPathOverride }
      : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    env: buildCodexEnv(opts.env),
  };
}

export function buildCodexThreadOptions(opts: {
  model: string;
  effort?: EffortLevel;
  cwd: string;
  posture: CodexPosture;
}): ThreadOptions {
  return {
    model: opts.model,
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    sandboxMode: opts.posture.sandboxMode,
    approvalPolicy: opts.posture.approvalPolicy,
    ...(effortToCodexEffort(opts.effort) !== undefined
      ? { modelReasoningEffort: effortToCodexEffort(opts.effort) }
      : {}),
  };
}
