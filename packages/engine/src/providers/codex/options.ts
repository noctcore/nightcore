import type {
  AutonomyLevel,
  EffortLevel,
  McpServerEntry,
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
