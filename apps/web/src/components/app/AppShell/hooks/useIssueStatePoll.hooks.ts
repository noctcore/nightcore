import { useCallback } from 'react';

import { pollIssueStates } from '@/lib/bridge';
import { useWindowFocusPoll } from '@/lib/useWindowFocusPoll';

/** GitHub two-way sync (#97 PR 4, §5) — the projection-IN observer. On app-window focus
 *  it fires `pollIssueStates`, which detects an upstream close/reopen on every issue-
 *  linked task and projects it onto `task.issueState` (the "closed upstream" chip). Runs
 *  REGARDLESS of the active view (it updates board-card chips, not the Issues list), but
 *  is gated on `enabled` (the `issueSyncEnabled` setting): when off, the focus listener is
 *  never registered.
 *
 *  READS ONLY — no lease, no mutation beyond the last-observed state; the Rust command
 *  early-outs with zero `gh` calls when no task links an issue, so a focus on a non-GitHub
 *  project costs nothing. Fire-and-forget: the board updates via the `nc:task` echoes the
 *  command emits, and a transient `gh` failure is logged, not toasted. */
export function useIssueStatePoll(enabled: boolean): void {
  const poll = useCallback(() => {
    void pollIssueStates().catch((err) => console.error('poll_issue_states failed', err));
  }, []);
  useWindowFocusPoll(poll, enabled);
}
