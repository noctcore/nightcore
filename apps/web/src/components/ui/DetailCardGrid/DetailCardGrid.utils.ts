/** Pure helpers for {@link DetailCardGrid}'s row-chunked virtualization. No
 *  React, no DOM — see apps/web/AGENTS.md "Folder-per-component". */
import type { ReactNode } from 'react';

/** Column-count breakpoints (px), mirroring the grid's own Tailwind classes
 *  (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`). Tailwind's `sm:`/`xl:`
 *  variants are VIEWPORT media queries, not container queries, so the JS
 *  column count must track the same viewport-width thresholds — kept in sync
 *  by hand since there's no way to read a Tailwind breakpoint back out of CSS. */
export const COLUMN_BREAKPOINT_SM = 640;
export const COLUMN_BREAKPOINT_XL = 1280;

/** The grid's column count for a given viewport width — 1 below `sm`, 2 from
 *  `sm` up to `xl`, 3 at `xl` and above. */
export function columnsForViewportWidth(width: number): number {
  if (width >= COLUMN_BREAKPOINT_XL) return 3;
  if (width >= COLUMN_BREAKPOINT_SM) return 2;
  return 1;
}

/** One virtualized grid row: either up to `columns` packed cards, or a single
 *  full-width item (a {@link GridFullRow}-wrapped section header/banner). */
export interface GridRow {
  key: string;
  items: readonly ReactNode[];
  fullWidth: boolean;
}

/** A React element's own `key` when present (duck-typed — no React import),
 *  else a positional fallback. */
function keyOf(item: ReactNode, fallback: string): string {
  if (item !== null && typeof item === 'object' && 'key' in item) {
    const key = (item as { key: unknown }).key;
    if (key !== null && key !== undefined) return String(key);
  }
  return fallback;
}

/**
 * Chunk a flat list of grid children into virtualizable rows.
 *
 * Consecutive regular items pack `columns`-per-row, matching the CSS grid's
 * own column count. An item the caller's `isFullRow` predicate flags gets its
 * own dedicated row (mirrors a `col-span-full` affordance — a section header
 * or summary banner interleaved with cards, as PR Review's severity groups
 * do). Row keys compose from their constituent items' own keys rather than
 * array index, so inserting/removing a finding reconciles the shifted rows
 * instead of remounting every row after the edit.
 */
export function chunkIntoRows(
  items: readonly ReactNode[],
  columns: number,
  isFullRow: (item: ReactNode) => boolean,
): GridRow[] {
  const perRow = Math.max(columns, 1);
  const rows: GridRow[] = [];
  let buffer: ReactNode[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const key = `row:${buffer.map((item, i) => keyOf(item, `i${i}`)).join(',')}`;
    rows.push({ key, items: buffer, fullWidth: false });
    buffer = [];
  };

  for (const item of items) {
    if (isFullRow(item)) {
      flush();
      rows.push({ key: `full:${keyOf(item, `f${rows.length}`)}`, items: [item], fullWidth: true });
      continue;
    }
    buffer.push(item);
    if (buffer.length >= perRow) flush();
  }
  flush();

  return rows;
}
