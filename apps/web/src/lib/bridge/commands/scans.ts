/** Bridge commands shared by the whole scan family (Insight, Harness, Scorecard) —
 *  the pieces that are identical across all three rather than per-feature. */
import { tauriInvoke } from '../internal';
import type { ScanLimits } from '../types';

/** What a scan runs under when Settings carries no ceiling: nothing capped. Also the
 *  outside-Tauri fallback, so the CONFIGURE screen renders normally in the mock web
 *  harness instead of erroring on a missing backend. */
const UNCAPPED: ScanLimits = {};

/**
 * The per-pass ceilings a scan would run under, for the CONFIGURE screen (#401).
 *
 * `passCount` is the number of selected categories (Insight/Harness) or dimensions
 * (Scorecard). Rust resolves the Settings limits — project override → global — and
 * applies the divide-vs-pass-through rule, so this is the ceiling the run will
 * ACTUALLY dispatch with, not a web-side re-derivation of it.
 *
 * Advisory only: it drives a chip, never a gate. Any failure resolves to
 * {@link UNCAPPED} rather than blocking the screen.
 */
export async function previewScanLimits(passCount: number): Promise<ScanLimits> {
  return tauriInvoke<ScanLimits>('preview_scan_limits', { passCount }, UNCAPPED);
}
