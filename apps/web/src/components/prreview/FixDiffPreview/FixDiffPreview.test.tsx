import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type { WorktreeDiff } from '@/lib/bridge';

import { FixDiffPreview } from './FixDiffPreview';
import * as stories from './FixDiffPreview.stories';

const { Populated, Empty, LoadFailed } = composeStories(stories);

test('lists the fix commit changed files with the git summary', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByText('src/auth.ts')).toBeInTheDocument();
  await expect.element(screen.getByText('src/new.ts')).toBeInTheDocument();
  await expect.element(screen.getByText('2 files changed, +16 -2')).toBeInTheDocument();
});

test('expanding a file row reveals its unified-diff patch', async () => {
  const screen = render(<Populated />);
  const row = screen.getByRole('button', { name: /src\/auth\.ts/ });
  await expect.element(row).toBeInTheDocument();
  await row.click();
  // The patch's changed line renders once the lazy fetch resolves.
  await expect.element(screen.getByText(/\[redacted\]/)).toBeInTheDocument();
});

test('renders a quiet note when the fix commit changed nothing', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/no file changes to preview/i))
    .toBeInTheDocument();
});

test('degrades to a quiet note when the diff fetch fails', async () => {
  const screen = render(<LoadFailed />);
  await expect
    .element(screen.getByText(/could not load the fix diff/i))
    .toBeInTheDocument();
});

test('the error state offers a Retry that refetches the diff', async () => {
  const ok: WorktreeDiff = {
    files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    summary: '1 file changed, +1 -0',
    additions: 1,
    deletions: 0,
  };
  let calls = 0;
  const fetchDiff = (): Promise<WorktreeDiff> => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error('pr-fix registry unavailable'))
      : Promise.resolve(ok);
  };
  const screen = render(
    <FixDiffPreview fixId="prfix-1" fetchDiff={fetchDiff} fetchPatch={async () => ''} />,
  );
  await expect
    .element(screen.getByText(/could not load the fix diff/i))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /retry/i }).click();
  await expect.element(screen.getByText('src/a.ts')).toBeInTheDocument();
});
