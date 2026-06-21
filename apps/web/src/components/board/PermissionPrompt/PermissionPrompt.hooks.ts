/** Re-exports the shared input-summary helpers (M4.7 §B promoted them to
 *  `@/lib/summarize` so the TaskDetail tool list can reuse them). Kept here so the
 *  component + barrel imports stay stable. */
export { summarizeInput, truncate } from '@/lib/summarize';
