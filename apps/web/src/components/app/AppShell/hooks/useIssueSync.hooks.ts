import { useEffect, useRef } from 'react';

import { onTaskEvent, syncIssueStatus, type Task } from '@/lib/bridge';

/** Per-task trailing-debounce window for the issue-status writeback (ms). A burst
 *  of `nc:task` emits for one task (a rapid InProgress→Verifying→InProgress flap)
 *  collapses to a single `sync_issue_status` call carrying the latest state — the
 *  projection model makes "sync the LATEST state" correct (last-write-wins). */
const SYNC_DEBOUNCE_MS = 500;

/** The provenance prefix an Issue-Triage-converted task carries on `sourceRef`
 *  (`issue-triage:<runId>`). A pre-#97 task minted before the durable `issueNumber`
 *  stamp has this but no stamped number — the Rust command backfills the number
 *  lazily from the run (§2.3), so those tasks must still trigger the observer. */
const ISSUE_SOURCE_PREFIX = 'issue-triage:';

/** Whether a task is linked to a GitHub issue and so a writeback candidate: it
 *  either carries the durable stamped `issueNumber` (the #97 convert path) or an
 *  Issue-Triage `sourceRef` the Rust command can lazily backfill the number from.
 *  Everything else (hand-created tasks, scan/decompose provenance) is skipped
 *  cheaply, before any IPC. */
function isIssueLinked(task: Task): boolean {
  return task.issueNumber != null || (task.sourceRef?.startsWith(ISSUE_SOURCE_PREFIX) ?? false);
}

/** GitHub two-way sync (#97, §3.6) — the writeback observer. Watches the app-wide
 *  `nc:task` stream and, for every issue-linked task (`issueNumber != null`), fires
 *  `syncIssueStatus(taskId)` to project the task's Nightcore lifecycle onto its
 *  linked GitHub issue (the `nc:*` status label + terminal comments). Debounced
 *  PER TASK so flaps coalesce; fire-and-forget (errors surface via the task's
 *  `issueSyncError` field, not a toast storm).
 *
 *  Gated on `enabled` (the `issueSyncEnabled` setting): when off, the observer does
 *  not subscribe at all — it is fully inert (no listener, no timers). Writeback is
 *  opt-in because it MUTATES a (often public) GitHub repo, and the Rust command is
 *  independently gated too, so a stale enabled flag can never write back.
 *
 *  This is the web-observer idiom (a sibling of the other app-wide `nc:task`
 *  observers): it keeps network I/O off the orchestration hot path, gets free
 *  debounce/coalescing, and is trivially toggled. Registered in `AppShell.hooks`. */
export function useIssueSync(enabled: boolean): void {
  // Per-task debounce timers, keyed by task id, so a flap on one task never
  // resets another's window. A ref (not state) so scheduling never re-renders.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    // Inert when disabled: no subscription, so a disabled observer costs nothing.
    if (!enabled) return;
    const pending = timers.current;
    const fire = (taskId: string) => {
      pending.delete(taskId);
      void syncIssueStatus(taskId).catch((err) =>
        console.error('sync_issue_status failed', err),
      );
    };
    const unlisten = onTaskEvent((task) => {
      // Only issue-linked tasks writeback; everything else is ignored cheaply.
      if (!isIssueLinked(task)) return;
      const existing = pending.get(task.id);
      if (existing !== undefined) clearTimeout(existing);
      pending.set(
        task.id,
        setTimeout(() => fire(task.id), SYNC_DEBOUNCE_MS),
      );
    });
    return () => {
      void unlisten.then((fn) => fn());
      // Drop every pending timer so a late writeback can't fire after teardown
      // (a settings toggle-off, a project switch, or unmount).
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, [enabled]);
}
