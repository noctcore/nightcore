/**
 * Shared task↔terminal link store (cockpit spec PR 4, decision 2/3).
 *
 * Lives in `@/lib` (not a feature) so BOTH the terminal feature — which creates the
 * links, marks sessions "ungoverned", and renders the linkage chip — and the board's
 * `TaskCard` — which shows a terminal chip + routes to the linked tab — can read it
 * without a cross-feature import. Module-level (outside React), so a link survives the
 * routed views' remounts exactly like the terminal session manager's own caches.
 *
 * A link is a convenience LABEL + context-injection marker only. It never touches task
 * status, the run lifecycle, gates, the gauntlet, or the flight recorder (decision 3:
 * terminal work can never mark a task verified). It is web-side state, never persisted
 * to the task file — seeded from live sessions and dropped when a session ends.
 *
 * Invariants: a task links to at most one live terminal and a terminal to at most one
 * task (both maps stay in sync). A session is "ungoverned" when it is task-linked OR
 * was used to launch `claude` — both run as the user, outside the agent guardrails.
 */
import { useSyncExternalStore } from 'react';

/** sessionId → linked taskId. */
const sessionToTask = new Map<string, string>();
/** taskId → linked sessionId (the inverse, kept in lockstep). */
const taskToSession = new Map<string, string>();
/** sessionIds where the user ran the one-click "Launch Claude" affordance — marked
 *  ungoverned even without a task link (they still run `claude` outside the gates). */
const claudeLaunched = new Set<string>();

/** A board→terminal hand-off: the session a routing action asked the Terminal view to
 *  activate on mount. Consumed once (not part of the subscribable snapshot). */
let pendingActivateSession: string | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to any link change (link/unlink/claude-launch/reconcile). Returns an
 *  unsubscribe. Used by the terminal hook to re-derive its per-session markers and by
 *  the board card's {@link useLinkedSessionId}. */
export function subscribeTerminalLinks(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Link `taskId` to `sessionId`, clearing any prior link on EITHER side first (a task
 *  and a terminal each hold at most one link). A no-op that skips the notify when the
 *  exact pair is already linked. */
export function linkTaskToSession(taskId: string, sessionId: string): void {
  if (sessionToTask.get(sessionId) === taskId) return;
  // Drop whatever the session and the task were each previously linked to.
  const priorTaskForSession = sessionToTask.get(sessionId);
  if (priorTaskForSession !== undefined) taskToSession.delete(priorTaskForSession);
  const priorSessionForTask = taskToSession.get(taskId);
  if (priorSessionForTask !== undefined) sessionToTask.delete(priorSessionForTask);
  sessionToTask.set(sessionId, taskId);
  taskToSession.set(taskId, sessionId);
  notify();
}

/** Remove a session's task link (the linkage chip's "clear/switch" affordance). Keeps
 *  the session's claude-launched marker — clearing the task link doesn't make a
 *  claude-launched terminal governed. Notifies only when something changed. */
export function clearSessionTaskLink(sessionId: string): void {
  const taskId = sessionToTask.get(sessionId);
  if (taskId === undefined) return;
  sessionToTask.delete(sessionId);
  taskToSession.delete(taskId);
  notify();
}

/** Forget every marker for a session (its shell closed). Drops the task link and the
 *  claude-launched flag. Notifies only when something was actually removed. */
export function forgetSession(sessionId: string): void {
  const taskId = sessionToTask.get(sessionId);
  const hadClaude = claudeLaunched.delete(sessionId);
  if (taskId === undefined) {
    if (hadClaude) notify();
    return;
  }
  sessionToTask.delete(sessionId);
  taskToSession.delete(taskId);
  notify();
}

/** The task linked to `sessionId`, or `null`. */
export function getTaskForSession(sessionId: string): string | null {
  return sessionToTask.get(sessionId) ?? null;
}

/** The live session linked to `taskId`, or `null` (drives the board card chip). */
export function getSessionForTask(taskId: string): string | null {
  return taskToSession.get(taskId) ?? null;
}

/** Mark a session as one where `claude` was launched (decision 3) — ungoverned even
 *  with no task link. Notifies only on a first mark. */
export function markClaudeLaunched(sessionId: string): void {
  if (claudeLaunched.has(sessionId)) return;
  claudeLaunched.add(sessionId);
  notify();
}

/** Whether a session is "ungoverned": task-linked or claude-launched (decision 3). */
export function isUngovernedSession(sessionId: string): boolean {
  return sessionToTask.has(sessionId) || claudeLaunched.has(sessionId);
}

/** Drop any link / claude-launch marker whose session id is not in `liveSessionIds`
 *  (reaped server-side / never restored). Called by the Terminal view on mount to
 *  reconcile the store with server truth. Notifies only when it pruned something. */
export function reconcileTerminalLinks(liveSessionIds: readonly string[]): void {
  const live = new Set(liveSessionIds);
  let changed = false;
  for (const [sessionId, taskId] of [...sessionToTask]) {
    if (!live.has(sessionId)) {
      sessionToTask.delete(sessionId);
      taskToSession.delete(taskId);
      changed = true;
    }
  }
  for (const sessionId of [...claudeLaunched]) {
    if (!live.has(sessionId)) {
      claudeLaunched.delete(sessionId);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Ask the Terminal view to activate `sessionId` when it next mounts (the board
 *  card's chip → route → activate hand-off). */
export function requestActivateSession(sessionId: string): void {
  pendingActivateSession = sessionId;
}

/** Take (and clear) any pending activation request. The Terminal view calls this on
 *  mount, after its live sessions load, to focus the requested tab. */
export function consumePendingActivateSession(): string | null {
  const id = pendingActivateSession;
  pendingActivateSession = null;
  return id;
}

/** React binding for the board card: the live session linked to `taskId`, or `null`,
 *  re-rendering the card whenever the link changes. */
export function useLinkedSessionId(taskId: string): string | null {
  return useSyncExternalStore(
    subscribeTerminalLinks,
    () => getSessionForTask(taskId),
    () => null,
  );
}

/** Test-only: clear every link + marker so cases don't leak module state. */
export function resetTerminalLinksForTest(): void {
  sessionToTask.clear();
  taskToSession.clear();
  claudeLaunched.clear();
  pendingActivateSession = null;
}
