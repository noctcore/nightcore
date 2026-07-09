import type { IssueSummary } from '@/lib/bridge';

/** Coerce an unknown thrown value to a message string. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Filter issues (client-side) by number, title, labels, and author. */
export function matchesFilter(issue: IssueSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  if (`#${issue.number}`.includes(q)) return true;
  if (issue.title.toLowerCase().includes(q)) return true;
  if (issue.author.toLowerCase().includes(q)) return true;
  return issue.labels.some((label) => label.toLowerCase().includes(q));
}
