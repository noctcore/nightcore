/** Shared story/test fixtures for the Terminal feature (not a component — the
 *  `_`-prefix keeps it out of the folder-structure lint). Full `Task` /
 *  `TerminalSessionInfo` builders so the task-integration stories + tests don't
 *  re-declare the canonical shapes. */
import type { Task, TerminalSessionInfo } from '@/lib/bridge';

/** A full `TerminalSessionInfo` with sensible defaults; override any field. */
export function makeTerminalSession(
  over: Partial<TerminalSessionInfo> & { id: string },
): TerminalSessionInfo {
  return {
    cwd: `/Users/dev/nightcore/.nightcore/worktrees/${over.id}`,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: 1_718_900_000_000,
    title: null,
    titleSource: null,
    ...over,
  };
}

/** A full `Task` fixture (mirrors the board fixture shape, kept here so the terminal
 *  feature never cross-imports the board's fixtures). */
export function makeTerminalTask(over: Partial<Task> = {}): Task {
  const now = 1_718_900_000_000;
  return {
    seq: 0,
    id: 'task-1',
    title: 'Add dark-mode toggle',
    description: 'Wire a theme switch into the settings drawer and persist the choice.',
    status: 'backlog',
    dependencies: [],
    model: 'opus-4.8',
    effort: null,
    permissionMode: null,
    branch: null,
    createdAt: now,
    updatedAt: now,
    sessionId: null,
    sdkSessionId: null,
    summary: null,
    error: null,
    costUsd: null,
    plan: null,
    committed: false,
    merged: false,
    conflict: false,
    kind: 'build',
    runMode: 'main',
    verified: false,
    review: null,
    fixAttempts: 0,
    structureLockResult: null,
    verifyCommand: null,
    maxTurns: null,
    maxBudgetUsd: null,
    attachments: [],
    parentTaskId: null,
    proposedSubtasks: [],
    sourceRef: null,
    ...over,
  };
}
