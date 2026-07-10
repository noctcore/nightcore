/** Prop + view types for the drawer's Trust band (wayfinder #91). The band owns
 *  the report fetch + export/preview orchestration through `useTrustReport`; the
 *  presentational sub-components take the fetched report (`TrustReportData`) or the
 *  assembled `TrustReportView`. */
import type { Task, TrustReport as TrustReportData } from '@/lib/bridge';

export type { TrustReportData };

/** The Trust band's export sub-state — the native save-dialog → Rust-write flow,
 *  with inline pending/error/success feedback (the drawer surfaces it in place,
 *  mirroring the usePrStatus inline-state idiom rather than a global toast). */
export interface TrustExportView {
  /** Fire the export: native save dialog → `write_trust_report`. */
  run: () => void;
  /** True while the dialog + atomic write is in flight (the button disables). */
  pending: boolean;
  /** The last export failure, shown inline; a new attempt clears it. */
  error: string | null;
  /** The path of the last successful save (the transient "Saved to …" note). */
  savedPath: string | null;
}

/** The Trust band's PR-attachment sub-state (PR 3): the human-gated post of the
 *  `for_github` receipt as a conversation comment on the task's PR, behind a
 *  ConfirmDialog. Single-flight via `pending`; inline pending/error/success
 *  feedback (mirroring the export flow rather than a global toast). */
export interface TrustAttachView {
  /** Whether the task has a PR to attach to — gates the button's presence
   *  (`task.prUrl !== undefined`). */
  available: boolean;
  /** Arm the ConfirmDialog (open it). */
  arm: () => void;
  /** Whether the ConfirmDialog is armed/open. */
  arming: boolean;
  /** Dismiss the ConfirmDialog without posting. */
  cancel: () => void;
  /** Post the receipt as a PR comment (the ConfirmDialog's confirm). No-ops
   *  while a post is already in flight (single-flight). */
  confirm: () => void;
  /** True while the comment POST is in flight (the confirm shows a spinner). */
  pending: boolean;
  /** The last attach failure, shown inline; a new attempt clears it. */
  error: string | null;
  /** True after a successful attach (the transient "Attached to the pull
   *  request" note). */
  done: boolean;
}

/** The Trust band's in-drawer markdown-preview sub-state. The canonical markdown is
 *  fetched lazily (once) the first time the preview opens. */
export interface TrustPreviewView {
  open: boolean;
  /** Toggle the preview open/closed. */
  toggle: () => void;
  /** The canonical markdown once fetched, or null. */
  markdown: string | null;
  loading: boolean;
  error: string | null;
}

/** Everything the Trust band renders from — the fetched report plus the export +
 *  preview sub-states. Assembled by `useTrustReport` and memoized so it can cross
 *  the memoized `TaskDetailChrome` without churning on a stream flush. */
export interface TrustReportView {
  /** The computed report, or null (still loading / unavailable). */
  report: TrustReportData | null;
  loading: boolean;
  /** True when the command resolved its outside-Tauri sentinel (browser preview). */
  unavailable: boolean;
  /** The last fetch failure. */
  error: string | null;
  export: TrustExportView;
  attach: TrustAttachView;
  preview: TrustPreviewView;
}

/** Props for the Trust band. Owns the report fetch + export/preview orchestration
 *  through `useTrustReport(task, trustReport)`. */
export interface TrustReportProps {
  task: Task;
  /** Story/test override for the fetched report; when provided (including `null`)
   *  the fetch is skipped and this renders directly. */
  trustReport?: TrustReportData | null;
}

/** Props for the presentational sub-sections — the fetched report, non-null. */
export interface TrustSectionProps {
  report: TrustReportData;
}
