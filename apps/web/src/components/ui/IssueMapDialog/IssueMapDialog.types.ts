/** Props for the IssueMapDialog — the human gate before a scan's findings are
 *  minted onto GitHub as a native sub-issue map. Cloned from `CreatePRDialog`'s
 *  full-preview-then-confirm shape: the dialog owns its preview fetch + export
 *  state machine in its hooks; the parent owns only `open` / `runId` / `scanKind`
 *  and closes the dialog by dropping `open`. */
import type { IssueMapPreview, IssueMapResult, IssueMapScanKind } from '@/lib/bridge';

/** Story/test seed for the dialog (the `useTrustReport` `override` idiom). When
 *  provided — even as an empty object — NO bridge command fires; the dialog
 *  renders the seeded state directly. The production trigger omits it, so the
 *  real preview fetch + export path runs. */
export interface IssueMapDialogOverride {
  /** Seed the built preview (renders the preview body without a live fetch). */
  preview?: IssueMapPreview | null;
  /** Seed a preview-fetch failure banner. */
  loadError?: string | null;
  /** Seed a terminal export result (success / partial / degraded banner). */
  result?: IssueMapResult | null;
  /** Seed a hard export-rejection banner. */
  exportError?: string | null;
  /** Seed the in-flight state (the confirm button shows the progress label). */
  submitting?: boolean;
  /** Seed the live progress counters. */
  progress?: { created: number; total: number } | null;
}

export interface IssueMapDialogProps {
  /** Whether the dialog is mounted/visible. */
  open: boolean;
  /** Which scan kind is being exported (`insight` | `scorecard` | `enforce`). */
  scanKind: IssueMapScanKind;
  /** The completed run to export. `null` renders the dialog inert (no fetch) —
   *  the trigger only opens it with a real run, but the dialog tolerates null. */
  runId: string | null;
  /** Fired on Esc, click-outside, the close affordance, Cancel, and Done. A
   *  NO-OP is enforced INSIDE the dialog while an export is in flight (an
   *  irreversible GitHub write must not be orphaned by an unmount). */
  onClose: () => void;
  /** Story/test seed — omit in production (the real fetch/export path runs). */
  override?: IssueMapDialogOverride;
}
