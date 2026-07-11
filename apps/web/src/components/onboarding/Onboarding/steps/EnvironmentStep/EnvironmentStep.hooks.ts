import { useMemo } from 'react';

import type { ToolCheck } from '@/lib/bridge';

import { codexRequired } from '../../Onboarding.hooks';
import type { OnboardingViewState } from '../../Onboarding.types';
import type {
  EnvironmentRowIcon,
  EnvironmentRowModel,
  EnvironmentStepState,
} from './EnvironmentStep.types';

function pendingRow(
  id: string,
  label: string,
  icon: EnvironmentRowIcon,
  optional = false,
): EnvironmentRowModel {
  return {
    id,
    label,
    icon,
    optional,
    ready: false,
    detail: 'checking...',
    fixHint: '',
    fixCommand: '',
  };
}

function installRow(
  tool: ToolCheck,
  label: string,
  icon: EnvironmentRowIcon,
  optional = false,
): EnvironmentRowModel {
  return {
    id: `${tool.id}-install`,
    label,
    icon,
    optional,
    ready: tool.installed,
    detail: tool.installed
      ? [tool.version, tool.path].filter(Boolean).join(' · ')
      : 'not installed',
    fixHint: tool.fixHint,
    fixCommand: tool.fixCommand,
  };
}

function authRow(
  tool: ToolCheck,
  label: string,
  icon: EnvironmentRowIcon,
  optional = false,
): EnvironmentRowModel {
  const ready = tool.authenticated !== false;
  return {
    id: `${tool.id}-auth`,
    label,
    icon,
    optional,
    ready,
    detail: ready ? tool.detail : 'not logged in on this machine',
    fixHint: tool.fixHint,
    fixCommand: tool.fixCommand,
  };
}

function rowsFromChecks(view: OnboardingViewState): readonly EnvironmentRowModel[] {
  const checks = view.checks;
  // Codex is optional UNLESS it's the active provider; GitHub CLI is always optional
  // (its features degrade, they don't block first-run).
  const codexOptional = !codexRequired(view.activeProvider);
  if (checks === null) {
    return [
      pendingRow('claude-install', 'Claude Code CLI', 'terminal'),
      pendingRow('claude-auth', 'Claude authenticated', 'key'),
      pendingRow('codex-install', 'Codex CLI', 'terminal', codexOptional),
      pendingRow('codex-auth', 'Codex authenticated', 'key', codexOptional),
      pendingRow('gh-install', 'GitHub CLI', 'github', true),
      pendingRow('gh-auth', 'GitHub authenticated', 'github', true),
      pendingRow('git-install', 'Git', 'checks'),
    ];
  }
  return [
    installRow(checks.claude, 'Claude Code CLI', 'terminal'),
    authRow(checks.claude, 'Claude authenticated', 'key'),
    installRow(checks.codex, 'Codex CLI', 'terminal', codexOptional),
    authRow(checks.codex, 'Codex authenticated', 'key', codexOptional),
    installRow(checks.gh, 'GitHub CLI', 'github', true),
    authRow(checks.gh, 'GitHub authenticated', 'github', true),
    installRow(checks.git, 'Git', 'checks'),
  ];
}

export function useEnvironmentStep(view: OnboardingViewState): EnvironmentStepState {
  const rows = useMemo(() => rowsFromChecks(view), [view]);
  // The checks resolve as one batch, so the reveal is gated on that — no artificial
  // per-row stagger (the prior 500ms/row delay was pure cosmetics that slowed the
  // first-run gate and the tests).
  const ready = view.checks !== null;
  const failedRequired = ready && rows.some((row) => !row.ready && row.optional !== true);

  return {
    rows,
    animationDone: ready,
    failedRequired,
    isCheckingRow: () => !ready,
  };
}
