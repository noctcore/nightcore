/** Pure presentation helpers for the FixRunCard (no state — the card is a
 *  controlled composition; all state lives in the PrReviewView model). */
import type { PrFixState } from '@/lib/bridge';

/** The running strip's line, kind-aware: what the agent is doing and where.
 *  An unknown future kind degrades to a generic "Running a fix" — never a
 *  wrong claim. */
export function runningLabel(fix: PrFixState): string {
  const n = fix.findingCount;
  switch (fix.kind) {
    case 'findings':
      return `Addressing ${n} ${n === 1 ? 'finding' : 'findings'} on ${fix.branch}`;
    case 'ci':
      return `Fixing ${n} failing ${n === 1 ? 'check' : 'checks'} on ${fix.branch}`;
    case 'conflicts':
      return `Resolving ${n} conflicted ${n === 1 ? 'file' : 'files'} on ${fix.branch}`;
    default:
      return `Running a fix on ${fix.branch}`;
  }
}

/** The awaiting-push footnote: the commit already exists locally — the push is
 *  the only step that publishes anything. */
export const LOCAL_COMMIT_NOTE =
  'The fix is already committed locally on the branch — pushing is what publishes it to the PR.';
