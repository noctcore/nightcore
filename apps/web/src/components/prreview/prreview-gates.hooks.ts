/**
 * The human-gated action state machines of the PR workspace — split out of the
 * PrReviewView mega-hook along its "post-review state machine" concern. Four
 * gates, one discipline each: an armed ConfirmDialog, an in-flight flag with a
 * synchronous ref twin (double-fire + cancel guard), and a kept-open dialog on
 * failure (inline error + toast):
 *   1. post-review  — compose + post the selected findings to GitHub;
 *   2. address      — start a fix agent on the PR branch for the selection;
 *   3. push-fix     — push a committed fix (THE external side effect);
 *   4. fix-action   — the status block's Fix CI / Resolve conflicts starters.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import { postReviewToGithub, type PrReviewRun } from '@/lib/bridge';

import type { ReviewFindingView, ReviewVerdict } from './prreview.types';
import { composeReviewBody, composeReviewComments } from './prreview-compose';
import type { UsePrFixesResult } from './prreview-fixes.hooks';
import type { ReviewStream } from './prreview-stream';

/** The workspace slices the gates act against (captured at confirm time). */
export interface PrReviewGatesConfig {
  /** Project identity — a switch closes every gate synchronously. */
  projectPath: string | null;
  /** The displayed run's PR — the post target. */
  postPrNumber: number | null;
  /** The address target (the displayed run's PR, else the selected PR). */
  addressPrNumber: number | null;
  selectedPr: number | null;
  displayRunId: string | null;
  /** Selected, non-dismissed findings (the post payload). */
  selectedFindings: ReviewFindingView[];
  /** Only OPEN selected findings (the fix prompt's payload). */
  selectedOpenFindings: ReviewFindingView[];
  selectRun: (runId: string) => Promise<ReviewStream | null>;
  refreshRuns: () => Promise<PrReviewRun[]>;
  /** The per-PR fix registry (address / push / CI / conflicts seams). */
  fixes: UsePrFixesResult;
  /** Clear the post selection after a successful post. */
  clearSelection: () => void;
}

/** Everything the gates expose to the workspace composition. */
export interface PrReviewGatesApi {
  // Post-review gate
  postVerdict: ReviewVerdict | null;
  posting: boolean;
  postError: string | null;
  /** The count the last successful post carried (auto-clearing chip), or null. */
  postedFeedback: number | null;
  requestPost: (verdict: ReviewVerdict) => void;
  confirmPost: () => void;
  cancelPost: () => void;
  // Address gate
  addressArmed: boolean;
  addressing: boolean;
  requestAddress: () => void;
  confirmAddress: () => void;
  cancelAddress: () => void;
  // Push gate
  /** The armed fix id (dialog open when non-null). */
  pushFixId: string | null;
  pushing: boolean;
  pushError: string | null;
  pushPostComment: boolean;
  setPushPostComment: (next: boolean) => void;
  requestPush: (fixId: string) => void;
  confirmPush: () => void;
  cancelPush: () => void;
  // Status-block remediation gate
  fixActionArmed: 'ci' | 'conflicts' | null;
  fixActionBusy: boolean;
  armFixAction: (action: 'ci' | 'conflicts') => void;
  confirmFixAction: () => void;
  cancelFixAction: () => void;
  /** Close every gate (PR switch / preselect navigation) — each was armed
   *  against the previous selection's run/fix. */
  closeAll: () => void;
}

/** Own the four human gates. See the module comment for the shared discipline. */
export function usePrReviewGates({
  projectPath,
  postPrNumber,
  addressPrNumber,
  selectedPr,
  displayRunId,
  selectedFindings,
  selectedOpenFindings,
  selectRun,
  refreshRuns,
  fixes,
  clearSelection,
}: PrReviewGatesConfig): PrReviewGatesApi {
  const toast = useToast();
  // Post-review human gate: the pending verdict (dialog open when non-null), the
  // in-flight flag (blocks double-fire + cancel), and the last error.
  const [postVerdict, setPostVerdict] = useState<ReviewVerdict | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const postInFlight = useRef(false);
  // Post-success micro-feedback: the count of findings the last successful post
  // carried, shown as an auto-clearing inline confirmation near the toolbar.
  const [postedFeedback, setPostedFeedback] = useState<number | null>(null);
  // Address-findings human gate: the dialog flag, the in-flight flag (blocks
  // double-fire + cancel), and its ref twin (synchronous re-entrancy check).
  const [addressArmed, setAddressArmed] = useState(false);
  const [addressing, setAddressing] = useState(false);
  const addressInFlight = useRef(false);
  // Push-fix human gate: the armed fix id (dialog open when non-null), the
  // in-flight flag, and the last push error (kept-open dialog, like the post).
  const [pushFixId, setPushFixId] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const pushInFlight = useRef(false);
  // The push dialog's "post a summary comment" opt-in — STICKY across pushes
  // (a per-user preference more than a per-push decision), default on.
  const [pushPostComment, setPushPostComment] = useState(true);
  // Status-block remediation gates (Fix CI / Resolve conflicts): which action's
  // ConfirmDialog is armed, the in-flight flag, and its ref twin (synchronous
  // re-entrancy check — the address gate's discipline).
  const [fixActionArmed, setFixActionArmed] = useState<'ci' | 'conflicts' | null>(
    null,
  );
  const [fixActionBusy, setFixActionBusy] = useState(false);
  const fixActionInFlight = useRef(false);

  /** Close every gate — armed dialogs belong to the previous PR's selection. */
  const closeAll = useCallback(() => {
    setPostVerdict(null);
    setPostError(null);
    setPostedFeedback(null);
    setAddressArmed(false);
    setPushFixId(null);
    setPushError(null);
    setFixActionArmed(null);
  }, []);

  // Project-switch reset, synchronously before paint (the render-adjust
  // pattern): every gate was armed against the previous project's PRs.
  const [lastProject, setLastProject] = useState(projectPath);
  if (lastProject !== projectPath) {
    setLastProject(projectPath);
    setPostVerdict(null);
    setPostError(null);
    setPostedFeedback(null);
    setAddressArmed(false);
    setPushFixId(null);
    setPushError(null);
    setFixActionArmed(null);
  }

  // Auto-clear the post-success confirmation after a short beat (the reference's
  // transient toast-adjacent chip). prefers-reduced-motion is honored by the
  // global CSS rule; this timer just governs how long it lingers.
  useEffect(() => {
    if (postedFeedback === null) return;
    const t = window.setTimeout(() => setPostedFeedback(null), 4000);
    return () => window.clearTimeout(t);
  }, [postedFeedback]);

  // --- Post-review gate ----------------------------------------------------
  const requestPost = useCallback((verdict: ReviewVerdict) => {
    setPostError(null);
    setPostVerdict(verdict);
  }, []);

  const cancelPost = useCallback(() => {
    // Inert while a post is in flight (the dialog's Cancel is disabled too).
    if (postInFlight.current) return;
    setPostVerdict(null);
    setPostError(null);
  }, []);

  const confirmPost = useCallback(() => {
    if (postVerdict === null || postInFlight.current) return;
    if (postPrNumber === null || selectedFindings.length === 0) return;
    const verdict = postVerdict;
    const prNumber = postPrNumber;
    const count = selectedFindings.length;
    const body = composeReviewBody(verdict, selectedFindings);
    const comments = composeReviewComments(selectedFindings);
    // Stamp the DISPLAYED run so a successful post records `postedVerdict` /
    // `postedAt` on the right run (Rust accepts an optional run id).
    const runId = displayRunId;
    postInFlight.current = true;
    setPosting(true);
    setPostError(null);
    // Clear any prior confirmation so an identical-count re-post still re-fires
    // the chip (the value passes through null, re-triggering the auto-clear).
    setPostedFeedback(null);
    void (async () => {
      try {
        await postReviewToGithub(prNumber, verdict, body, comments, runId);
        // `post_review_to_github` stamps postedVerdict / postedAt server-side but
        // emits no pr-review event, so reload the run into the registry (like
        // convert/dismiss/restore) — otherwise the Posted lifecycle state, the
        // "Posted to GitHub" timeline node, and the reconcile banner keep reading
        // the stale null until an unrelated interaction refreshes the runs. A
        // reload failure must NOT turn a SUCCESSFUL post into an error — swallow
        // it (the registry self-heals on the next interaction).
        if (runId !== null) {
          await selectRun(runId).catch((e: unknown) =>
            console.error('selectRun after post failed (non-fatal)', e),
          );
          void refreshRuns();
        }
        toast.push({ tone: 'success', title: `Review posted to PR #${prNumber}` });
        // The auto-clearing "Posted N findings" inline confirmation.
        setPostedFeedback(count);
        setPostVerdict(null);
        clearSelection();
      } catch (err) {
        // Surface BOTH inline (kept dialog) and via toast (the useToast
        // discipline), and keep the verdict open so the user can retry/cancel.
        console.error('postReviewToGithub failed', err);
        setPostError(err instanceof Error ? err.message : String(err));
        toast.error('Could not post the review', err);
      } finally {
        setPosting(false);
        postInFlight.current = false;
      }
    })();
  }, [
    postVerdict,
    postPrNumber,
    selectedFindings,
    displayRunId,
    selectRun,
    refreshRuns,
    toast,
    clearSelection,
  ]);

  // --- Address-findings gate ------------------------------------------------
  const requestAddress = useCallback(() => setAddressArmed(true), []);

  const cancelAddress = useCallback(() => {
    // Inert while an address is in flight (the dialog's Cancel is disabled too).
    if (addressInFlight.current) return;
    setAddressArmed(false);
  }, []);

  const confirmAddress = useCallback(() => {
    if (addressInFlight.current) return;
    const prNumber = addressPrNumber;
    const runId = displayRunId;
    const findingIds = selectedOpenFindings.map((f) => f.id);
    if (prNumber === null || runId === null || findingIds.length === 0) return;
    addressInFlight.current = true;
    setAddressing(true);
    void (async () => {
      try {
        const { fixId, error } = await fixes.address(prNumber, runId, findingIds);
        // Success closes the gate (the running strip takes over via nc:pr-fix).
        // A rejection keeps the dialog open — the per-PR fix error renders
        // inline there — AND toasts (the post/push failure discipline). A
        // guarded-out null (no error) stays silent.
        if (fixId !== null) setAddressArmed(false);
        else if (error !== null) toast.error('Could not start the fix agent', error);
      } finally {
        setAddressing(false);
        addressInFlight.current = false;
      }
    })();
  }, [addressPrNumber, displayRunId, selectedOpenFindings, fixes, toast]);

  // --- Push-fix gate ---------------------------------------------------------
  const requestPush = useCallback((fixId: string) => {
    setPushError(null);
    setPushFixId(fixId);
  }, []);

  const cancelPush = useCallback(() => {
    // Inert while a push is in flight (the dialog's Cancel is disabled too).
    if (pushInFlight.current) return;
    setPushFixId(null);
    setPushError(null);
  }, []);

  const confirmPush = useCallback(() => {
    if (pushFixId === null || pushInFlight.current) return;
    const fixId = pushFixId;
    const postComment = pushPostComment;
    pushInFlight.current = true;
    setPushing(true);
    setPushError(null);
    void (async () => {
      try {
        const warning = await fixes.push(fixId, postComment);
        // A resolved WARNING means the push landed but the opt-in summary
        // comment didn't — say exactly that (info, not error: nothing is lost).
        if (typeof warning === 'string' && warning.length > 0) {
          toast.push({
            tone: 'info',
            title: 'Fix pushed — summary comment failed',
            description: warning,
          });
        } else {
          toast.push({ tone: 'success', title: 'Fix pushed to the PR branch' });
        }
        setPushFixId(null);
      } catch (err) {
        // Surface BOTH inline (kept dialog) and via toast (the useToast
        // discipline), and keep the gate open so the user can retry/cancel.
        console.error('push_pr_fix failed', err);
        setPushError(err instanceof Error ? err.message : String(err));
        toast.error('Could not push the fix', err);
      } finally {
        setPushing(false);
        pushInFlight.current = false;
      }
    })();
  }, [pushFixId, pushPostComment, fixes, toast]);

  // --- Status-block remediation gates (Fix CI / Resolve conflicts) --------
  const armFixAction = useCallback(
    (action: 'ci' | 'conflicts') => setFixActionArmed(action),
    [],
  );

  const cancelFixAction = useCallback(() => {
    // Inert while the action is in flight (the dialog's Cancel is disabled too).
    if (fixActionInFlight.current) return;
    setFixActionArmed(null);
  }, []);

  const confirmFixAction = useCallback(() => {
    if (fixActionArmed === null || fixActionInFlight.current) return;
    // The armed dialog belongs to the CURRENT selection (selectPr closes it),
    // so the state capture is the right PR.
    const prNumber = selectedPr;
    if (prNumber === null) return;
    const action = fixActionArmed;
    fixActionInFlight.current = true;
    setFixActionBusy(true);
    void (async () => {
      try {
        const { fixId, error } =
          action === 'ci'
            ? await fixes.fixCi(prNumber)
            : await fixes.resolveConflicts(prNumber);
        // Success closes the gate (the fix strip takes over via nc:pr-fix). A
        // rejection keeps the dialog open — the per-PR fix error renders inline
        // there — AND toasts (the address-gate discipline).
        if (fixId !== null) setFixActionArmed(null);
        else if (error !== null) {
          toast.error(
            action === 'ci'
              ? 'Could not start the CI fix'
              : 'Could not resolve the conflicts',
            error,
          );
        }
      } finally {
        setFixActionBusy(false);
        fixActionInFlight.current = false;
      }
    })();
  }, [fixActionArmed, selectedPr, fixes, toast]);

  return {
    postVerdict,
    posting,
    postError,
    postedFeedback,
    requestPost,
    confirmPost,
    cancelPost,
    addressArmed,
    addressing,
    requestAddress,
    confirmAddress,
    cancelAddress,
    pushFixId,
    pushing,
    pushError,
    pushPostComment,
    setPushPostComment,
    requestPush,
    confirmPush,
    cancelPush,
    fixActionArmed,
    fixActionBusy,
    armFixAction,
    confirmFixAction,
    cancelFixAction,
    closeAll,
  };
}
