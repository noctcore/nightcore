/** Shared numeric-ceiling commit validation for the editable number fields
 *  (TaskDetail's per-task `LimitField` and Settings' `NumberField`). Both fields
 *  share the same contract: empty ⇒ inherit (no-op), and a value is only
 *  committed when it parses to a finite number ≥ `min` AND differs from the
 *  current value. Returns the value to commit, or `null` when the input should be
 *  a no-op — keeping the seven-line validator in one tested place (#8). */
export function parseNumericCommit(
  raw: string,
  current: number | null,
  min: number,
): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed === current) return null;
  return parsed;
}
