import { composeStories } from '@storybook/react-vite';
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { classifyDiffLine, isBinaryPatch, parseDiffLines } from './DiffPatchView.hooks';
import * as stories from './DiffPatchView.stories';

const { Modified, Binary, Empty, Loading } = composeStories(stories);

describe('classifyDiffLine', () => {
  // The load-bearing ordering guard: `+++ `/`--- ` file headers start with +/-
  // but must classify as meta, NOT as added/removed content lines.
  test('classifies +++ / --- file headers as meta, not add/del', () => {
    expect(classifyDiffLine('+++ b/apps/web/src/lib/diff.ts')).toBe('meta');
    expect(classifyDiffLine('--- a/apps/web/src/lib/diff.ts')).toBe('meta');
  });

  test('classifies added and removed content lines', () => {
    expect(classifyDiffLine('+  const x = 1;')).toBe('add');
    expect(classifyDiffLine('-  const x = 0;')).toBe('del');
  });

  test('classifies hunk headers and diff/index/mode metadata', () => {
    expect(classifyDiffLine('@@ -1,6 +1,7 @@ fn context')).toBe('hunk');
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta');
    expect(classifyDiffLine('index 1a2b3c4..5d6e7f8 100644')).toBe('meta');
    expect(classifyDiffLine('new file mode 100644')).toBe('meta');
    expect(classifyDiffLine('deleted file mode 100644')).toBe('meta');
  });

  test('classifies unmarked lines as context', () => {
    expect(classifyDiffLine(' unchanged line')).toBe('context');
    expect(classifyDiffLine('')).toBe('context');
  });
});

describe('parseDiffLines', () => {
  test('returns no lines for a null / empty / binary patch', () => {
    expect(parseDiffLines(null)).toEqual([]);
    expect(parseDiffLines('')).toEqual([]);
    expect(parseDiffLines('   \n  ')).toEqual([]);
    expect(parseDiffLines('Binary file assets/logo.png (not shown)')).toEqual([]);
  });

  test('trims a single trailing newline so no phantom blank final row renders', () => {
    const lines = parseDiffLines('+a\n-b\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.kind)).toEqual(['add', 'del']);
  });

  test('classifies every line of a real patch, headers before content', () => {
    const kinds = parseDiffLines(
      ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new', ' ctx'].join('\n'),
    ).map((l) => l.kind);
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'hunk', 'del', 'add', 'context']);
  });
});

test('isBinaryPatch only matches the backend binary sentinel', () => {
  expect(isBinaryPatch('Binary file x (not shown)')).toBe(true);
  expect(isBinaryPatch('+Binary file x')).toBe(false);
  expect(isBinaryPatch(null)).toBe(false);
});

test('renders colored add / del lines from a modified patch', async () => {
  const screen = render(<Modified />);
  await expect.element(screen.getByText('+  // compare both sides now')).toBeInTheDocument();
  await expect
    .element(screen.getByText('-export function diff(a: string) {'))
    .toBeInTheDocument();
});

test('renders the binary sentinel as a quiet note (no diff rows)', async () => {
  const screen = render(<Binary />);
  await expect
    .element(screen.getByText('Binary file assets/logo.png (not shown)'))
    .toBeInTheDocument();
  expect(screen.container.querySelector('pre')).toBeNull();
});

test('renders the empty note when there is no textual diff', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No textual changes to show.')).toBeInTheDocument();
});

test('shows the spinner branch — no diff rows and no empty note — while loading', async () => {
  const screen = render(<Loading />);
  // The loading branch renders neither the patch block nor the empty-note copy,
  // just the spinner — distinguishing it from the empty state.
  expect(screen.container.querySelector('pre')).toBeNull();
  expect(screen.container.textContent).not.toContain('No textual changes to show.');
});
