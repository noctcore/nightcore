/**
 * Pure composers for the posted GitHub review: the verdict-framed body markdown
 * and the inline comments, both built from the SELECTED findings. Nightcore's
 * own trusted text — never raw foreign diff. No React, no bridge calls.
 */
import type { ReviewInlineComment } from '@/lib/bridge';

import { LENS_META, SEVERITY_META, SEVERITY_ORDER } from './prreview.constants';
import type { ReviewFindingView, ReviewVerdict } from './prreview.types';

/** The one-line verdict framing prepended to the composed review body. */
const VERDICT_SUMMARY: Record<ReviewVerdict, string> = {
  approve: 'Approving — the changes look good. Notes below.',
  'request-changes':
    'Requesting changes — please address the findings below before merge.',
  comment: 'Review notes below.',
};

/** Compose the review body markdown from the SELECTED findings, grouped by
 *  severity. Nightcore's own trusted text — never raw foreign diff. */
export function composeReviewBody(
  verdict: ReviewVerdict,
  findings: ReviewFindingView[],
): string {
  const lines: string[] = ['## Nightcore PR Review', '', VERDICT_SUMMARY[verdict]];
  for (const severity of SEVERITY_ORDER) {
    const items = findings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;
    lines.push('', `### ${SEVERITY_META[severity].label}`);
    for (const f of items) {
      const loc = f.line !== null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`- ${loc} — **${f.title}** _(${LENS_META[f.lens].label})_`);
    }
  }
  lines.push('', '_Posted from Nightcore._');
  return lines.join('\n');
}

/** Inline comments for the SELECTED findings that carry a line anchor. The body is
 *  Nightcore-composed (title + finding body) — trusted text, never the raw diff. */
export function composeReviewComments(
  findings: ReviewFindingView[],
): ReviewInlineComment[] {
  return findings
    .filter((f) => f.line !== null)
    .map((f) => ({
      path: f.file,
      line: f.line as number,
      body: `${f.title}\n\n${f.body}`,
    }));
}
