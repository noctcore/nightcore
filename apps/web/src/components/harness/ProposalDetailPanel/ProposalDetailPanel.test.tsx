import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProposalDetailPanel.stories';

const { Open, Dismissed, Converted, ApplyArtifacts, Applied } = composeStories(stories);

test('renders the proposal title, prompt, and verify command', async () => {
  const screen = render(<Open />);
  await expect
    .element(screen.getByText('Wire the generated ESLint plugin into eslint.config.ts'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Task for the agent')).toBeInTheDocument();
  await expect.element(screen.getByText('Verify with')).toBeInTheDocument();
});

test('converts the proposal into a task via the action button', async () => {
  const onConvert = vi.fn();
  const screen = render(<Open onConvert={onConvert} />);
  await screen.getByRole('button', { name: /convert to task/i }).click();
  expect(onConvert).toHaveBeenCalledWith('hp-1');
});

test('dismisses the proposal via the action button', async () => {
  const onDismiss = vi.fn();
  const screen = render(<Open onDismiss={onDismiss} />);
  await screen.getByRole('button', { name: /dismiss/i }).click();
  expect(onDismiss).toHaveBeenCalledWith('hp-1');
});

test('a converted proposal offers a go-to-task action instead of convert', async () => {
  const onGotoBoard = vi.fn();
  const screen = render(<Converted onGotoBoard={onGotoBoard} />);
  await expect
    .element(screen.getByRole('button', { name: /go to task/i }))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /go to task/i }).click();
  expect(onGotoBoard).toHaveBeenCalled();
});

test('a dismissed proposal offers a restore action', async () => {
  const onRestore = vi.fn();
  const screen = render(<Dismissed onRestore={onRestore} />);
  await screen.getByRole('button', { name: /restore/i }).click();
  expect(onRestore).toHaveBeenCalledWith('hp-1');
});

test('an apply-artifacts proposal offers a bundle-apply action', async () => {
  const onApply = vi.fn();
  const screen = render(<ApplyArtifacts onApply={onApply} />);
  await screen.getByRole('button', { name: /apply bundle/i }).click();
  expect(onApply).toHaveBeenCalledWith('hp-2');
});

test('an applied proposal shows an Applied state with no apply/convert action', async () => {
  const screen = render(<Applied />);
  await expect
    .element(screen.getByRole('button', { name: 'Applied' }))
    .toBeInTheDocument();
  expect(screen.container.querySelector('button:disabled')).not.toBeNull();
});
