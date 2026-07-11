/**
 * Task→terminal integration orchestration (cockpit spec PR 4, decisions 2 & 3).
 *
 * Owns the header task-dropdown's pickable list, the derived per-session "ungoverned"
 * / linked-title state (mirrored from the shared `@/lib/terminal-links` store), and the
 * imperative handlers: inject a task's context into a terminal, launch/resume `claude`,
 * and clear a link. Split out of `useTerminalView` so that hook stays under the
 * file-size ratchet; this is a feature-root hook module (the `terminal-*.ts` pattern).
 *
 * USER-ONLY seam: every handler here runs behind an explicit user gesture (a dropdown
 * pick, a button click) and writes into the human's own PTY via `terminal_write`. No
 * agent-reachable path calls into this module — injection is the human pasting context,
 * NOT the agent driving a shell (predecessor hard rule, preserved).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/ui';
import type { PersistedTerminalInfo, Task, TerminalSessionInfo, TitleSource } from '@/lib/bridge';
import { writeTerminal } from '@/lib/bridge';
import {
  clearSessionTaskLink,
  getTaskForSession,
  isUngovernedSession,
  linkTaskToSession,
  markClaudeLaunched,
  subscribeTerminalLinks,
} from '@/lib/terminal-links';

import {
  composeClaudeLaunch,
  composeClaudeResume,
  composeTaskContext,
  frameBracketedPaste,
  isPosixShell,
} from './terminal-inject';

/** Statuses whose tasks the header dropdown offers (the pre-run pool). */
const PICKABLE_STATUSES = new Set(['backlog', 'ready']);
/** Cap on the dropdown length — the most-recent pre-run tasks (decision 2, "top N"). */
const MAX_PICKABLE_TASKS = 20;

const encoder = new TextEncoder();

/** The tasks the header dropdown lists: the active project's pre-run tasks, most-recent
 *  first, capped. Pure + unit-tested. */
export function pickableTasksForTerminal(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => PICKABLE_STATUSES.has(task.status))
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PICKABLE_TASKS);
}

export interface UseTerminalTasksInput {
  /** The live sessions — the "ungoverned" / linked-title maps are keyed off these. */
  readonly sessions: readonly TerminalSessionInfo[];
  /** The active project's tasks (for the dropdown + resolving a linked task's title). */
  readonly tasks: readonly Task[];
  /** Canonical project root — composed into the injected `Task file:` path. */
  readonly projectPath: string | null;
  /** The YOLO launch flag (decision 3/4e): appends `--dangerously-skip-permissions`. */
  readonly yoloLaunch: boolean;
  /** PR 1 rename seam — a linked terminal auto-takes the task title (decision 2),
   *  written with the `'task'` precedence source (round-2 PR A) so it out-ranks an AI
   *  auto-name but yields to a manual rename. */
  readonly renameSession: (id: string, title: string, source: TitleSource) => void;
  /** Spawn a live shell in a cwd (the resume flow reuses the view's spawn path). */
  readonly spawnInto: (path: string, confined: boolean) => Promise<TerminalSessionInfo>;
  /** Drop a restored (read-only) tab after a fresh shell replaces it (resume flow). */
  readonly consumeRestored: (id: string) => void;
}

/** The task-integration state + handlers the terminal header / panes render from. */
export function useTerminalTasks({
  sessions,
  tasks,
  projectPath,
  yoloLaunch,
  renameSession,
  spawnInto,
  consumeRestored,
}: UseTerminalTasksInput) {
  const toast = useToast();

  // Mirror the module-level link store into React: bump a version on every change so
  // the derived ungoverned / linked-title maps recompute (mirrors the session
  // manager's activity subscription bridge).
  const [linkVersion, setLinkVersion] = useState(0);
  useEffect(() => subscribeTerminalLinks(() => setLinkVersion((v) => v + 1)), []);

  const pickableTasks = useMemo(() => pickableTasksForTerminal(tasks), [tasks]);

  const ungovernedIds = useMemo<ReadonlySet<string>>(() => {
    void linkVersion;
    return new Set(sessions.filter((s) => isUngovernedSession(s.id)).map((s) => s.id));
  }, [sessions, linkVersion]);

  const linkedTitleBySession = useMemo<ReadonlyMap<string, string>>(() => {
    void linkVersion;
    const map = new Map<string, string>();
    for (const session of sessions) {
      const taskId = getTaskForSession(session.id);
      if (taskId === null) continue;
      map.set(session.id, tasks.find((t) => t.id === taskId)?.title ?? taskId);
    }
    return map;
  }, [sessions, tasks, linkVersion]);

  /** Inject a task's context into a terminal (decision 2): frame the composed text in
   *  bracketed paste (no trailing newline — the user presses Enter), write it to the
   *  PTY, link the task, and auto-take its title. */
  const injectTask = useCallback(
    (session: TerminalSessionInfo, task: Task) => {
      const framed = frameBracketedPaste(composeTaskContext(task, projectPath));
      void writeTerminal(session.id, encoder.encode(framed));
      linkTaskToSession(task.id, session.id);
      // Task auto-take carries the `'task'` source — wins over an AI name, loses to a
      // manual rename (round-2 PR A precedence).
      renameSession(session.id, task.title, 'task');
    },
    [projectPath, renameSession],
  );

  /** Launch `claude` in a live terminal (decision 3): type the composed `cd … && claude`
   *  command (executes immediately) and mark the session ungoverned. */
  const launchClaude = useCallback(
    (session: TerminalSessionInfo) => {
      void writeTerminal(session.id, encoder.encode(composeClaudeLaunch(session.cwd, { yolo: yoloLaunch })));
      markClaudeLaunched(session.id);
    },
    [yoloLaunch],
  );

  /** Resume `claude` in a restored session's folder (decision 3): start a fresh shell in
   *  its cwd, swap out the read-only tab, then type `claude --continue`. */
  const resumeClaude = useCallback(
    async (info: PersistedTerminalInfo) => {
      try {
        const session = await spawnInto(info.cwd, info.confined);
        consumeRestored(info.id);
        markClaudeLaunched(session.id);
        void writeTerminal(session.id, encoder.encode(composeClaudeResume(session.cwd, { yolo: yoloLaunch })));
      } catch (err) {
        toast.error('Could not resume Claude', err);
      }
    },
    [spawnInto, consumeRestored, yoloLaunch, toast],
  );

  const clearLink = useCallback((id: string) => clearSessionTaskLink(id), []);

  /** Whether a session's shell can run the composed POSIX launch (decision 3). */
  const canLaunchClaude = useCallback((session: TerminalSessionInfo) => isPosixShell(session.shell), []);

  return {
    pickableTasks,
    ungovernedIds,
    linkedTitleBySession,
    injectTask,
    launchClaude,
    resumeClaude,
    clearLink,
    canLaunchClaude,
  };
}
