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

export function codexPostureForAutonomy(
  autonomy: AutonomyLevel,
  opts: { bypassOptedIn: boolean },
): CodexPosture {
  switch (autonomy) {
    case 'plan':
      return {
        autonomy,
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
        contained: true,
      };
    case 'ask':
      return {
        autonomy,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
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
