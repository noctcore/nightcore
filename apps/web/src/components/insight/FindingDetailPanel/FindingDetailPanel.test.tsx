import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './FindingDetailPanel.stories';

const { Open, Converted } = composeStories(stories);

test('renders the finding title and grounded location', async () => {
  const screen = render(<Open />);
  await expect.element(screen.getByText('Unawaited promise drops errors')).toBeInTheDocument();
  await expect.element(screen.getByText('src/a.ts:12-18 · save')).toBeInTheDocument();
});

test('converts the finding via the action button', async () => {
  const onConvert = vi.fn();
  const screen = render(<Open onConvert={onConvert} />);
  await screen.getByRole('button', { name: /convert to task/i }).click();
  expect(onConvert).toHaveBeenCalledWith('f1');
});

test('a converted finding offers a go-to-task action instead of convert', async () => {
  const onGotoBoard = vi.fn();
  const screen = render(<Converted onGotoBoard={onGotoBoard} />);
  await screen.getByRole('button', { name: /go to task/i }).click();
  expect(onGotoBoard).toHaveBeenCalledTimes(1);
});

test('renders before/after as syntax-highlighted code blocks', async () => {
  const screen = render(<Open />);
  // CodeBlock streams in Shiki HTML; once it resolves the keyword tokenizes into
  // its own element, proving the before/after code is wired through CodeBlock.
  await expect.element(screen.getByText('void', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('await', { exact: true })).toBeVisible();
});
