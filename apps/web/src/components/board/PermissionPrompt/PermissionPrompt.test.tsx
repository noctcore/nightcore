import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { summarizeInput, truncate } from './PermissionPrompt.hooks';
import * as stories from './PermissionPrompt.stories';

const { ShellCommand } = composeStories(stories);

test('shows the tool name, input summary, and Allow/Deny', async () => {
  const screen = render(<ShellCommand />);
  await expect.element(screen.getByText('Bash')).toBeInTheDocument();
  await expect
    .element(screen.getByText('rm -rf node_modules && bun install'))
    .toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
});

test('Allow and Deny relay the decision with the request id', async () => {
  const onRespond = vi.fn();
  const screen = render(<ShellCommand onRespond={onRespond} />);
  await screen.getByRole('button', { name: 'Allow' }).click();
  expect(onRespond).toHaveBeenCalledWith('req-1', 'allow');
  await screen.getByRole('button', { name: 'Deny' }).click();
  expect(onRespond).toHaveBeenCalledWith('req-1', 'deny');
});

test('summarizeInput prefers a telling field and truncates long input', () => {
  expect(summarizeInput({ command: 'ls -la' })).toBe('ls -la');
  expect(summarizeInput({ file_path: '/a/b.ts', extra: 1 })).toBe('/a/b.ts');
  expect(summarizeInput({})).toBe('(no input)');
  expect(summarizeInput({ misc: 'x' })).toContain('misc');
  expect(truncate('abcdef', 4)).toBe('abc…');
});
