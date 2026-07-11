import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './EvidenceBundle.stories';

const { Verified, GauntletFailed, NoDiff, MainMode, Unavailable } = composeStories(stories);

test('stages the receipt: verified verdict, diff stats, and cost in one bundle', async () => {
  const screen = render(<Verified />);
  await expect.element(screen.getByLabelText('Review evidence')).toBeInTheDocument();
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();
  // Diff stats (3 files · +128 −42) sit beside the receipt.
  await expect.element(screen.getByText(/3 files/)).toBeInTheDocument();
  await expect.element(screen.getByText('+128')).toBeInTheDocument();
  // The approximate total cost comes through the reused flight section (labelled ≈).
  await expect.element(screen.getByText(/≈ \$0\.86 total/)).toBeInTheDocument();
});

test('shows the failing gauntlet check verbatim so the reviewer can decide', async () => {
  const screen = render(<GauntletFailed />);
  await expect.element(screen.getByText('× Not verified')).toBeInTheDocument();
  await expect.element(screen.getByText(/5 files/)).toBeInTheDocument();
});

test('states an empty worktree diff explicitly rather than looking broken', async () => {
  const screen = render(<NoDiff />);
  await expect.element(screen.getByText(/No file changes vs base/)).toBeInTheDocument();
});

test('omits the diff row entirely for a main-mode task', async () => {
  const screen = render(<MainMode />);
  await expect.element(screen.getByLabelText('Review evidence')).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('file changes vs base');
});

test('degrades to a quiet note when the receipt is unavailable', async () => {
  const screen = render(<Unavailable />);
  await expect
    .element(screen.getByText(/unavailable in the browser preview/))
    .toBeInTheDocument();
});
