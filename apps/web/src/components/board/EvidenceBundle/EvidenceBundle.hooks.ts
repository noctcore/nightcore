/** Fetch + assemble the review-time Evidence bundle (T8): the per-task Trust
 *  receipt (`trust_report`) and the worktree diff stats (`worktree_diff`), fetched
 *  in parallel on mount / per task id. Both fail OPEN — a rejected diff or receipt
 *  degrades to `null` (rendered as a labelled note) rather than throwing, so a run
 *  with no diff (main-mode) or no ledger still shows the evidence it does have.
 *  Lifted per the `useTrustReport` idiom: a fetch on mount, a task-switch reset
 *  before paint, and an `override` seam for stories/tests. */
import { useEffect, useState } from 'react';

import type { Task, TrustReport } from '@/lib/bridge';
import { trustReport, worktreeDiff } from '@/lib/bridge';

import type { EvidenceData, EvidenceDiffStat, EvidenceView } from './EvidenceBundle.types';

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface EvidenceState {
  report: TrustReport | null;
  diff: EvidenceDiffStat | null;
  loading: boolean;
  unavailable: boolean;
  error: string | null;
}

const INITIAL: EvidenceState = {
  report: null,
  diff: null,
  loading: false,
  unavailable: false,
  error: null,
};

/** Fetch + assemble a task's review evidence. `override` is the story/test seam:
 *  when provided (including nulls) no command fires and it renders directly. */
export function useEvidenceBundle(task: Task, override?: EvidenceData): EvidenceView {
  const taskId = task.id;
  const skip = override !== undefined;

  const [state, setState] = useState<EvidenceState>(INITIAL);

  // Task-switch reset (the useTrustReport belt): the hook instance survives a
  // task switch, so task A's snapshot must not render against B until B's fetch
  // lands. Reset synchronously before paint.
  const [lastTaskId, setLastTaskId] = useState(taskId);
  if (lastTaskId !== taskId) {
    setLastTaskId(taskId);
    setState(INITIAL);
  }

  useEffect(() => {
    if (skip) return;
    let stale = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    // The receipt and the diff are independent — settle both so a rejected diff
    // never suppresses the receipt (and vice-versa). Neither can throw here.
    void Promise.allSettled([trustReport(taskId), worktreeDiff(taskId)]).then(
      ([reportRes, diffRes]) => {
        if (stale) return;
        const report = reportRes.status === 'fulfilled' ? reportRes.value : null;
        const diff: EvidenceDiffStat | null =
          diffRes.status === 'fulfilled'
            ? {
                files: diffRes.value.files.length,
                additions: diffRes.value.additions,
                deletions: diffRes.value.deletions,
              }
            : null;
        const error = reportRes.status === 'rejected' ? errorText(reportRes.reason) : null;
        setState({
          report,
          diff,
          loading: false,
          // A `null` receipt with no error is the outside-Tauri sentinel / nothing
          // recorded yet — a quiet note, not an error.
          unavailable: report === null && error === null,
          error,
        });
      },
    );
    return () => {
      stale = true;
    };
  }, [skip, taskId]);

  if (override !== undefined) {
    return {
      report: override.report,
      diff: override.diff,
      loading: false,
      unavailable: override.report === null,
      error: null,
    };
  }
  return state;
}
