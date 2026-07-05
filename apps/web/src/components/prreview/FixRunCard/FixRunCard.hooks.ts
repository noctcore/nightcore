/** Pure presentation helpers for the FixRunCard (no state — the card is a
 *  controlled composition; all state lives in the PrReviewView model). */
import type { PrFixState } from '@/lib/bridge';

/** The running strip's line: "Addressing K finding(s) on <branch>". */
export function runningLabel(fix: PrFixState): string {
  const noun = fix.findingCount === 1 ? 'finding' : 'findings';
  return `Addressing ${fix.findingCount} ${noun} on ${fix.branch}`;
}

/** The awaiting-push footnote: the commit already exists locally — the push is
 *  the only step that publishes anything. */
export const LOCAL_COMMIT_NOTE =
  'The fix is already committed locally on the branch — pushing is what publishes it to the PR.';
