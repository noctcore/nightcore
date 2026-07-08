import { useEffect, useMemo, useState } from 'react';

import type { ToolCheck } from '@/lib/bridge';

import type { OnboardingViewState } from '../../Onboarding.types';
import type {
  EnvironmentRowIcon,
  EnvironmentRowModel,
  EnvironmentStepState,
} from './EnvironmentStep.types';

const ROW_DELAY_MS = 500;

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
): EnvironmentRowModel {
  return {
    id: `${tool.id}-install`,
    label,
    icon,
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
  if (checks === null) {
    return [
      pendingRow('claude-install', 'Claude Code CLI', 'terminal'),
      pendingRow('claude-auth', 'Claude authenticated', 'key'),
      pendingRow('gh-install', 'GitHub CLI', 'github'),
      pendingRow('gh-auth', 'GitHub authenticated', 'github', true),
      pendingRow('git-install', 'Git', 'checks'),
    ];
  }
  return [
    installRow(checks.claude, 'Claude Code CLI', 'terminal'),
    authRow(checks.claude, 'Claude authenticated', 'key'),
    installRow(checks.gh, 'GitHub CLI', 'github'),
    authRow(checks.gh, 'GitHub authenticated', 'github', true),
    installRow(checks.git, 'Git', 'checks'),
  ];
}

export function useEnvironmentStep(view: OnboardingViewState): EnvironmentStepState {
  const rows = useMemo(() => rowsFromChecks(view), [view]);
  const [completedRows, setCompletedRows] = useState(0);

  useEffect(() => {
    setCompletedRows(0);
    if (view.checks === null) return;
    let row = 0;
    const timer = window.setInterval(() => {
      row += 1;
      setCompletedRows(row);
      if (row >= rows.length) window.clearInterval(timer);
    }, ROW_DELAY_MS);
    return () => window.clearInterval(timer);
  }, [rows.length, view.checks]);

  const animationDone = completedRows >= rows.length && view.checks !== null;
  const failedRequired =
    animationDone && rows.some((row) => !row.ready && row.optional !== true);

  return {
    rows,
    animationDone,
    failedRequired,
    isCheckingRow: (index) => view.checks === null || index >= completedRows,
  };
}
