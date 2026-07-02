import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ConventionDetailPanel.stories';

const { Open, Dismissed, Converted } = composeStories(stories);

test('renders the convention title and grounded evidence', async () => {
  const screen = render(<Open />);
  await expect
    .element(screen.getByText('Folder-per-component with a colocated sibling set'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText('apps/web/src/components/board/TaskCard/TaskCard.tsx:1-40 · TaskCard'))
    .toBeInTheDocument();
});

test('dismisses the convention via the action button', async () => {
  const onDismiss = vi.fn();
  const screen = render(<Open onDismiss={onDismiss} />);
  await screen.getByRole('button', { name: /dismiss/i }).click();
  expect(onDismiss).toHaveBeenCalledWith('c1');
});

test('converts the convention into a task via the action button', async () => {
  const onConvert = vi.fn();
  const screen = render(<Open onConvert={onConvert} />);
  await screen.getByRole('button', { name: /convert to task/i }).click();
  expect(onConvert).toHaveBeenCalledWith('c1');
});

test('a converted convention offers a go-to-task action instead of convert', async () => {
  const onGotoBoard = vi.fn();
  const screen = render(<Converted onGotoBoard={onGotoBoard} />);
  // The convert affordance is replaced by "Go to task" once converted.
  await expect
    .element(screen.getByRole('button', { name: /go to task/i }))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /go to task/i }).click();
  expect(onGotoBoard).toHaveBeenCalled();
});

test('a dismissed convention offers a restore action', async () => {
  const onRestore = vi.fn();
  const screen = render(<Dismissed onRestore={onRestore} />);
  await screen.getByRole('button', { name: /restore/i }).click();
  expect(onRestore).toHaveBeenCalledWith('c1');
});
