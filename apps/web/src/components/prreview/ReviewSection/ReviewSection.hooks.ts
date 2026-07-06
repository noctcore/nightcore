/** Pure presentation helpers for the ReviewSection (no state — the section is a
 *  controlled composition; all state lives in the PrReviewView model). */
import type { ReviewStream } from '../prreview-stream';
import type { ReviewSectionMode } from './ReviewSection.types';

/** The disabled-verdict explanation for the own-PR guard. GitHub rejects
 *  approve/request-changes reviews on the viewer's own pull request. */
export const OWN_PR_TITLE =
  "GitHub doesn't allow approve/request-changes on your own pull request — post as comment instead";

/** The disabled-Address explanation while this PR already has a fix in flight
 *  (one running fix per PR — the Rust registry refuses a second anyway). */
export const FIX_RUNNING_TITLE =
  'A fix agent is already running for this PR — wait for it to finish';

/** The section's persistent sr-only live-region line: announces the run-state
 *  transitions (running → completed/failed) that the old RunLifecycleShell
 *  screens used to announce by swapping whole views. Empty in config mode and
 *  while nothing noteworthy is displayed — a polite region ignores ''. */
export function sectionStatusMessage(
  mode: ReviewSectionMode,
  stream: ReviewStream | null,
): string {
  if (mode === 'running') return 'Review running';
  if (mode !== 'results' || stream === null) return '';
  if (stream.status === 'completed') {
    const n = stream.findings.length;
    return `Review completed, ${n} ${n === 1 ? 'finding' : 'findings'}`;
  }
  if (stream.status === 'failed') return 'Review failed';
  return '';
}
