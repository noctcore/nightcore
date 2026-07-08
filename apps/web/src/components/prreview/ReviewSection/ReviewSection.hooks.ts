/** Pure presentation helpers for the ReviewSection (no state — the section is a
 *  controlled composition; all state lives in the PrReviewView model). */
import type { ReviewStream } from '../prreview-stream';
import type { ReviewSectionMode } from './ReviewSection.types';

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
