import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
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
