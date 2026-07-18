import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { CONFIRM_CHORD } from '@/lib/platform';

import { summarizeInput, truncate } from './PermissionPromptCard.hooks';
import * as stories from './PermissionPromptCard.stories';

const { ShellCommand } = composeStories(stories);

test('shows the tool name, input summary, and Allow/Deny', async () => {
  const screen = render(<ShellCommand />);
  await expect.element(screen.getByText('Bash')).toBeInTheDocument();
  await expect
    .element(screen.getByText('rm -rf node_modules && bun install'))
    .toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /allow/i })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
});

test('Allow relays the decision with the request id', async () => {
  const onRespond = vi.fn();
  const screen = render(<ShellCommand onRespond={onRespond} />);
  await screen.getByRole('button', { name: /allow/i }).click();
  expect(onRespond).toHaveBeenCalledWith('req-1', 'allow');
});

test('Deny relays the decision with the request id', async () => {
  const onRespond = vi.fn();
  const screen = render(<ShellCommand onRespond={onRespond} />);
  await screen.getByRole('button', { name: /deny/i }).click();
  expect(onRespond).toHaveBeenCalledWith('req-1', 'deny');
});

test('the Allow button carries the platform-aware confirm-chord keyboard hint', async () => {
  const screen = render(<ShellCommand />);
  const kbd = screen.container.querySelector('kbd');
  expect(kbd?.textContent).toBe(CONFIRM_CHORD);
});

test('deciding latches both buttons disabled + aria-busy so it cannot double-fire', async () => {
  const onRespond = vi.fn();
  const screen = render(<ShellCommand onRespond={onRespond} />);
  await screen.getByRole('button', { name: /allow/i }).click();
  expect(onRespond).toHaveBeenCalledTimes(1);
  // Both controls latch once a decision is in flight — no second dispatch.
  await expect.element(screen.getByRole('button', { name: /allow/i })).toBeDisabled();
  await expect
    .element(screen.getByRole('button', { name: /allow/i }))
    .toHaveAttribute('aria-busy', 'true');
  await expect.element(screen.getByRole('button', { name: /deny/i })).toBeDisabled();
  await expect
    .element(screen.getByRole('button', { name: /deny/i }))
    .toHaveAttribute('aria-busy', 'true');
});

test('Cmd/Ctrl+Enter approves from anywhere in the prompt', async () => {
  const onRespond = vi.fn();
  const screen = render(<ShellCommand onRespond={onRespond} />);
  const form = screen.container.querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  expect(onRespond).toHaveBeenCalledWith('req-1', 'allow');
});

test('summarizeInput prefers a telling field and truncates long input', () => {
  expect(summarizeInput({ command: 'ls -la' })).toBe('ls -la');
  expect(summarizeInput({ file_path: '/a/b.ts', extra: 1 })).toBe('/a/b.ts');
  expect(summarizeInput({})).toBe('(no input)');
  expect(summarizeInput({ misc: 'x' })).toContain('misc');
  expect(truncate('abcdef', 4)).toBe('abc…');
});
