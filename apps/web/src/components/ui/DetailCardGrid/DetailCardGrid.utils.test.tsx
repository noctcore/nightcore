import { isValidElement, type ReactNode } from 'react';
import { expect, test } from 'vitest';

import {
  chunkIntoRows,
  COLUMN_BREAKPOINT_SM,
  COLUMN_BREAKPOINT_XL,
  columnsForViewportWidth,
} from './DetailCardGrid.utils';

test('columnsForViewportWidth resolves 1/2/3 columns at the sm/xl breakpoints', () => {
  expect(columnsForViewportWidth(0)).toBe(1);
  expect(columnsForViewportWidth(COLUMN_BREAKPOINT_SM - 1)).toBe(1);
  expect(columnsForViewportWidth(COLUMN_BREAKPOINT_SM)).toBe(2);
  expect(columnsForViewportWidth(COLUMN_BREAKPOINT_XL - 1)).toBe(2);
  expect(columnsForViewportWidth(COLUMN_BREAKPOINT_XL)).toBe(3);
  expect(columnsForViewportWidth(COLUMN_BREAKPOINT_XL + 500)).toBe(3);
});

test('chunkIntoRows packs regular items columns-per-row, in order', () => {
  const items = Array.from({ length: 7 }, (_, i) => <div key={`c${i}`}>c{i}</div>);
  const rows = chunkIntoRows(items, 3, () => false);

  expect(rows).toHaveLength(3);
  expect(rows[0]?.items).toHaveLength(3);
  expect(rows[1]?.items).toHaveLength(3);
  expect(rows[2]?.items).toHaveLength(1);
  expect(rows.every((row) => !row.fullWidth)).toBe(true);
});

test('chunkIntoRows gives a full-row item its own dedicated row', () => {
  const items = [
    <div key="a">a</div>,
    <div key="b">b</div>,
    <div key="header">header</div>,
    <div key="c">c</div>,
  ];
  // Typed against `chunkIntoRows`'s own `(item: ReactNode) => boolean`
  // predicate param — `isValidElement` narrows to `ReactElement` (which has a
  // `.key`) without an unsound cast.
  const isFullRow = (item: ReactNode): boolean =>
    isValidElement(item) && item.key === 'header';
  const rows = chunkIntoRows(items, 2, isFullRow);

  // a+b pack a 2-column row, "header" gets its own row, then c starts a fresh row.
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ fullWidth: false, items: [items[0], items[1]] });
  expect(rows[1]).toMatchObject({ fullWidth: true, items: [items[2]] });
  expect(rows[2]).toMatchObject({ fullWidth: false, items: [items[3]] });
});

test('chunkIntoRows row keys are stable across a shifted item list', () => {
  const before = [
    <div key="x">x</div>,
    <div key="y">y</div>,
    <div key="z">z</div>,
  ];
  const after = [
    // "y" removed — "x" and "z" now pack the same row together.
    <div key="x">x</div>,
    <div key="z">z</div>,
  ];
  const beforeRows = chunkIntoRows(before, 2, () => false);
  const afterRows = chunkIntoRows(after, 2, () => false);

  // The row key reflects its actual constituent items, not a positional
  // index — removing "y" changes row 0's key rather than silently reusing it
  // for a different pair of items.
  expect(beforeRows[0]?.key).not.toBe(afterRows[0]?.key);
});

test('chunkIntoRows treats a non-positive column count as at least 1', () => {
  const items = [<div key="a">a</div>, <div key="b">b</div>];
  const rows = chunkIntoRows(items, 0, () => false);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.items.length === 1)).toBe(true);
});
