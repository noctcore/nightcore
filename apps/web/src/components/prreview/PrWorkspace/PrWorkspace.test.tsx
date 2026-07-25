import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PrWorkspace.stories';

const { Selected, TypedNumberNotInList, WithChangedFiles } = composeStories(stories);

test('renders the PR header: title, author, labels, and the status block', async () => {
  const screen = render(<Selected />);
  await expect
    .element(screen.getByRole('heading', { name: /youtube cookie auth/i }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('@Shironex')).toBeInTheDocument();
  await expect.element(screen.getByText('enhancement')).toBeInTheDocument();
  // The status block renders from the override snapshot.
  await expect.element(screen.getByText('Clean against base')).toBeInTheDocument();
  await expect.element(screen.getByText(/base: main/)).toBeInTheDocument();
});

test('the open-on-GitHub button reports the PR url', async () => {
  const onOpenExternal = vi.fn();
  const screen = render(<Selected onOpenExternal={onOpenExternal} />);
  await screen.getByRole('button', { name: /open on github/i }).click();
  expect(onOpenExternal).toHaveBeenCalledWith(
    'https://github.com/Shironex/shiranami/pull/40',
  );
});

test('frames the description as untrusted, sanitized content', async () => {
  const screen = render(<Selected />);
  // The threat-model detail moved to the pill's title; only "sanitized" shows.
  await expect
    .element(screen.getByText(/^sanitized$/i))
    .toHaveAttribute('title', 'Untrusted contributor content · sanitized');
  await expect.element(screen.getByText(/^background$/i)).toBeInTheDocument();
});

test('a typed number not in the list still offers the review action', async () => {
  const screen = render(<TypedNumberNotInList />);
  await expect
    .element(screen.getByText(/isn.t in the open list/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /review pr #999/i }))
    .toBeInTheDocument();
});

test('the changed-file count expands to a per-file list with +/- deltas', async () => {
  const screen = render(<WithChangedFiles />);
  // Collapsed by default — the files toggle is present but no rows yet.
  const toggle = screen.getByRole('button', { name: /files/i });
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
  // The override seeds the list — a path row with its per-file deltas renders.
  await expect
    .element(screen.getByText('src/main/downloader/cookies.ts'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('+84').first()).toBeInTheDocument();
  // Once loaded, the toggle shows the file count.
  await expect.element(toggle).toHaveTextContent(/4\s*files/i);
});
