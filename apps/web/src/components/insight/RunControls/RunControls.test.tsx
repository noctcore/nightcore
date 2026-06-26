import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './RunControls.stories';

const { Idle, Running } = composeStories(stories);

test('fires onAnalyze with the default scope and every category selected', async () => {
  const onAnalyze = vi.fn();
  const screen = render(<Idle onAnalyze={onAnalyze} />);
  await screen.getByRole('button', { name: /^analyze$/i }).click();
  const call = onAnalyze.mock.calls[0];
  expect(call?.[0]).toBe('repo');
  // All nine categories selected by default.
  expect(call?.[1]).toHaveLength(9);
});

test('clearing the selection disables Analyze', async () => {
  const onAnalyze = vi.fn();
  const screen = render(<Idle onAnalyze={onAnalyze} />);
  await screen.getByRole('button', { name: /^none$/i }).click();
  await expect.element(screen.getByRole('button', { name: /^analyze$/i })).toBeDisabled();
});

test('a running stream swaps Analyze for a cancel action', async () => {
  const onCancel = vi.fn();
  const screen = render(<Running onCancel={onCancel} />);
  await screen.getByRole('button', { name: /cancel analysis/i }).click();
  expect(onCancel).toHaveBeenCalledTimes(1);
});
