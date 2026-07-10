/** Bridge commands — the GitHub issue-map export (wayfinder #112). Thin wrappers
 *  over the `preview_issue_map` / `export_issue_map` Tauri commands: the first
 *  builds the human-gate preview (parent body + every sub-issue title + groups +
 *  supersede + soft warning) from a COMPLETED scan run; the second mints the map
 *  on GitHub (parent + one native sub-issue per finding), taking back only the
 *  deterministic inputs plus the previewed narrative + the once-minted timestamp
 *  so the posted bytes are exactly what the preview showed (§3.8). Both REJECT
 *  outside the Tauri webview (browser preview / stories) rather than pretending a
 *  GitHub write happened — like `createPrTask`, an irreversible remote mutation
 *  has no meaningful browser fallback. */
import { invoke } from '@tauri-apps/api/core';

import type { IssueMapPreview, IssueMapResult, Narrative } from '../types';

/** The three exportable scan kinds — the wire string the Rust `ScanKind`
 *  round-trips (`insight` | `scorecard` | `enforce`). PR Review + Issue Triage
 *  are excluded (their output already lives on GitHub, §1). */
export type IssueMapScanKind = 'insight' | 'scorecard' | 'enforce';

/** Build the full preview payload for a completed run of `scanKind` (§3.1): the
 *  rendered parent markdown, every sub-issue title in deterministic order, the
 *  group counts, the prior-map supersede link (if one is open), the >50 soft
 *  warning, and the fail-open LLM narrative threaded back for the write. Runs one
 *  `gh` read (prior-map discovery) + one `claude -p` narrative pass. REJECTS
 *  outside Tauri (no active project / no `gh`). */
export async function previewIssueMap(
  scanKind: IssueMapScanKind,
  runId: string,
): Promise<IssueMapPreview> {
  return invoke<IssueMapPreview>('preview_issue_map', { scanKind, runId });
}

/** Mint the map on GitHub (§3.2): ensure the `nc:*` labels, create the parent,
 *  then sequentially create + native-attach one sub-issue per finding, optionally
 *  closing a superseded prior map. Takes back the previewed `narrative` +
 *  `generatedAt` UNCHANGED (Rust re-sanitizes + re-derives everything else) so
 *  preview == post. Emits `nc:issue-map` progress during the loop (consume via
 *  `onIssueMapEvent`); resolves the terminal `IssueMapResult` — which may be a
 *  partial (a mid-run failure STOPS and returns what landed, never a rollback) or
 *  a degraded-linkage (native sub-issues unavailable → task-list fallback)
 *  outcome. REJECTS outside Tauri. */
export async function exportIssueMap(
  scanKind: IssueMapScanKind,
  runId: string,
  generatedAt: string,
  narrative: Narrative,
  closeSuperseded: boolean,
): Promise<IssueMapResult> {
  return invoke<IssueMapResult>('export_issue_map', {
    scanKind,
    runId,
    generatedAt,
    narrative,
    closeSuperseded,
  });
}
