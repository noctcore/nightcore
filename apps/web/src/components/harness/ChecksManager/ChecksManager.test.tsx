import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ChecksManager.stories';

const { Populated, WithFailure, Empty, Editing, Validated, ValidationFailed, DeepRun } =
  composeStories(stories);

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

test('a lint-plugin check exposes a Validate rule action', async () => {
  const screen = render(<Populated />);
  await expect
    .element(screen.getByRole('button', { name: /validate rule folder-per-component/i }))
    .toBeInTheDocument();
});

test('a validated rule shows its RuleTester verdict inline', async () => {
  const screen = render(<Validated />);
  await expect.element(screen.getByText(/real rule/i)).toBeInTheDocument();
});

test('a failed validation shows the runner diagnostic message', async () => {
  const screen = render(<ValidationFailed />);
  await expect.element(screen.getByText(/could not validate/i)).toBeInTheDocument();
  await expect.element(screen.getByText(/module not found/i)).toBeInTheDocument();
});

/** The deep conformance audit (#279) is a PAID pass, so the panel must state its
 *  price before the user commits — not after the bill arrives. */
test('the deep-audit opt-in is off by default and shows its cost ceiling up front', async () => {
  const screen = render(<Populated />);
  const box = screen.getByRole('checkbox', { name: /deep conformance audit/i });
  await expect.element(box).toBeInTheDocument();
  await expect.element(box).not.toBeChecked();
  await expect.element(screen.getByText(/\$2\.00 ceiling/)).toBeInTheDocument();
  await expect.element(screen.getByText(/this pass is paid/i)).toBeInTheDocument();
});

/** A deep run stays distinguishable after the fact — the banner labels it, which is
 *  the same recoverable depth the carry-forward comparison keys on. */
test('the last-run banner marks a run that included the deep audit', async () => {
  const screen = render(<DeepRun />);
  await expect.element(screen.getByText(/deep audit/i)).toBeInTheDocument();
});
