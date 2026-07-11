import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ChecksManager.stories';

const { Populated, WithFailure, Empty, Editing } = composeStories(stories);

test('lists each armed check with its command and kind', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByText('folder-per-component')).toBeInTheDocument();
  await expect.element(screen.getByText('architecture-boundaries')).toBeInTheDocument();
  await expect.element(screen.getByText('npx eslint .')).toBeInTheDocument();
  // The run-now command is present.
  await expect
    .element(screen.getByRole('button', { name: /run armed checks now/i }))
    .toBeInTheDocument();
  // The last-run banner.
  await expect.element(screen.getByText(/all passed/i)).toBeInTheDocument();
});

test('a disabled check exposes an off toggle', async () => {
  const screen = render(<Populated />);
  const toggle = screen.getByRole('switch', { name: /architecture-boundaries enabled/i });
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
});

test('a failing check shows its exit code and captured output', async () => {
  const screen = render(<WithFailure />);
  await expect.element(screen.getByText('exit 1')).toBeInTheDocument();
  await expect.element(screen.getByText(/does not meet threshold/i)).toBeInTheDocument();
  await expect.element(screen.getByText(/failed at coverage-threshold/i)).toBeInTheDocument();
});

test('the empty state guides the user to arm a check', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText(/no checks armed yet/i)).toBeInTheDocument();
});

test('the inline editor renders the checks fields when a row is open', async () => {
  const screen = render(<Editing />);
  await expect.element(screen.getByText('Command')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});
