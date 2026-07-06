/**
 * Results-view derivations shared across the scan siblings: grounded-location
 * normalization, the lens-tab strip with its per-lens open counts, the
 * running-scan skeleton count, and the in-place single-item stream patch (the
 * `*-converted` / `*-applied` notice body). Re-exported from the `@/lib/scan-run`
 * barrel.
 */
import type { ScanStepProgress } from './lifecycle';

/** The repo-relative code anchor a scan view renders: the wire schema's optional
 *  fields normalized to explicit nulls. */
export interface NormalizedLocation {
  file: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

/** The location shape both sources carry: the live wire schema (optional fields)
 *  and the persisted ts-rs projection (explicit nulls). */
export interface LocationLike {
  file: string;
  startLine?: number | null;
  endLine?: number | null;
  symbol?: string | null;
}

/** Normalize a grounded location into the view shape (absent → explicit `null`).
 *  This exact block was cloned across the scan `*-stream.ts` normalizers
 *  (insight ×1, scorecard ×4, harness ×1). The non-nullable overload keeps
 *  `evidence.map(normalizeLocation)` free of null checks. */
export function normalizeLocation(loc: LocationLike): NormalizedLocation;
export function normalizeLocation(
  loc: LocationLike | null | undefined,
): NormalizedLocation | null;
export function normalizeLocation(
  loc: LocationLike | null | undefined,
): NormalizedLocation | null {
  if (loc === null || loc === undefined) return null;
  return {
    file: loc.file,
    startLine: loc.startLine ?? null,
    endLine: loc.endLine ?? null,
    symbol: loc.symbol ?? null,
  };
}

/** How many open (unresolved) items a scan run currently shows. */
export function countOpenItems<Item extends { status: string }>(
  items: readonly Item[],
): number {
  return items.filter((i) => i.status === 'open').length;
}

/** Total items per lens (the RunProgress per-lens counters). */
export function countByLens<Item>(
  items: readonly Item[],
  lensOf: (item: Item) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const lens = lensOf(item);
    counts[lens] = (counts[lens] ?? 0) + 1;
  }
  return counts;
}

/** One results-tab descriptor: the `'all'` head or a lens tab with its open
 *  count and live run state. Structurally identical to each family's local
 *  `CategoryTab`. */
export interface LensTab<Lens extends string> {
  key: 'all' | Lens;
  count: number;
  running: boolean;
  errored: boolean;
}

/**
 * Build the results tab strip: an `'all'` head (open count across every lens,
 * running while any lens runs) plus one tab per visible lens — those requested
 * this run or that produced items (covers loading a past run whose requested
 * set we project from) — in canonical (`all`) order. Cloned byte-identical by
 * the Insight and Harness view models.
 */
export function buildLensTabs<Item extends { status: string }, Lens extends string>(opts: {
  /** The full lens vocabulary in canonical display order. */
  all: readonly Lens[];
  /** The lenses requested this run. */
  requested: readonly Lens[];
  /** The per-lens live progress map (`categoryState` / `lensState`). */
  stepState: Record<string, ScanStepProgress>;
  items: readonly Item[];
  lensOf: (item: Item) => Lens;
}): LensTab<Lens>[] {
  const present = new Set<Lens>(opts.requested);
  for (const item of opts.items) present.add(opts.lensOf(item));
  const visible = opts.all.filter((l) => present.has(l));
  const runningCount = Object.values(opts.stepState).filter(
    (s) => s === 'running',
  ).length;
  const openCount = (lens?: Lens) =>
    opts.items.filter(
      (i) => i.status === 'open' && (lens === undefined || opts.lensOf(i) === lens),
    ).length;
  return [
    { key: 'all', count: openCount(), running: runningCount > 0, errored: false },
    ...visible.map((l) => ({
      key: l,
      count: openCount(l),
      running: opts.stepState[l] === 'running',
      errored: opts.stepState[l] === 'error',
    })),
  ];
}

/**
 * How many skeleton cards the results grid shows while the scan runs: on the
 * `'all'` tab, two per currently-running lens (capped at 6); on a lens tab,
 * three while that lens runs. Zero once the run settles. Cloned byte-identical
 * by the Insight and Harness view models.
 */
export function scanSkeletonCount(
  status: string,
  stepState: Record<string, ScanStepProgress>,
  activeTab: string,
): number {
  if (status !== 'running') return 0;
  if (activeTab === 'all') {
    const running = Object.values(stepState).filter((s) => s === 'running').length;
    return Math.min(6, running * 2);
  }
  return stepState[activeTab] === 'running' ? 3 : 0;
}

/** The inputs to {@link patchStreamItem} — one item's in-place lifecycle mark. */
export interface StreamItemPatch<Stream, Item extends { id: string }> {
  /** The run the notice targets; a stream showing a different run is untouched. */
  runId: string;
  itemId: string;
  /** Read the item list off the stream (e.g. `s.findings`). */
  items: (s: Stream) => Item[];
  /** Write the item list back (e.g. `(s, findings) => ({ ...s, findings })`). */
  write: (s: Stream, items: Item[]) => Stream;
  /** The lifecycle mark (e.g. flip to `converted` with the linked task id). */
  patch: (item: Item) => Item;
}

/**
 * Patch one item (by id) on one run's stream — the shared body of every
 * `*-converted` / `*-applied` notice handler. Matches on `stream.runId` (NOT the
 * live-fold gate) so a mutation against a displayed-but-not-live run still
 * updates in place; any other run's stream is returned untouched.
 */
export function patchStreamItem<
  Stream extends { runId: string | null },
  Item extends { id: string },
>(prev: Stream, opts: StreamItemPatch<Stream, Item>): Stream {
  if (prev.runId !== opts.runId) return prev;
  return opts.write(
    prev,
    opts.items(prev).map((i) => (i.id === opts.itemId ? opts.patch(i) : i)),
  );
}
