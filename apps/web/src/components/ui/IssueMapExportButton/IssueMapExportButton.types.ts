/** Props for the IssueMapExportButton — the self-contained "Export to GitHub"
 *  trigger that the three scan-results bars (Insight / Scorecard / Enforce) drop
 *  in as a sibling of the convert-all bar. It owns the dialog open-state itself
 *  (in its hooks) so the results views need not add any state or hook-return
 *  surface. */
import type { IssueMapScanKind } from '@/lib/bridge';

export interface IssueMapExportButtonProps {
  /** Which scan kind this results view exports (`insight` | `scorecard` |
   *  `enforce`). */
  scanKind: IssueMapScanKind;
  /** The completed run to export. `null` (no persisted run yet) renders the
   *  trigger disabled. */
  runId: string | null;
}
