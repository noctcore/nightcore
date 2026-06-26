import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import * as stories from './ApplyConfirmDialog.stories';

const { Default, Applying, WithError, GenericError, MergeSection } =
  composeStories(stories);

test('states the target path and write mode, and confirms via the Apply button', async () => {
  const onConfirm = vi.fn();
  const screen = render(<Default onConfirm={onConfirm} />);
  await expect
    .element(
      screen.getByText('packages/eslint-plugin/src/rules/component-folder-structure.ts'),
    )
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /^apply$/i }).click();
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test('a create artifact notes it writes a NEW file and is refused if the path exists', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText(/creates a/i)).toBeInTheDocument();
  await expect
    .element(screen.getByText(/refused \(never overwritten\)/i))
    .toBeInTheDocument();
});

test('a merge-section artifact does not show the create-only note', async () => {
  const screen = render(<MergeSection />);
  expect(screen.container.textContent).not.toContain('Creates a');
});

test('cancels via Esc', async () => {
  const onCancel = vi.fn();
  render(<Default onCancel={onCancel} />);
  // Esc routes through the shared Modal's keydown handler.
  await userEvent.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalled();
});

test('disables both actions while the write is in flight', async () => {
  const screen = render(<Applying />);
  await expect.element(screen.getByRole('button', { name: /applying/i })).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
});

test('translates an "already exists" failure into a friendly explanation', async () => {
  const screen = render(<WithError />);
  await expect
    .element(screen.getByText(/won't overwrite it\. Review and replace it manually/i))
    .toBeInTheDocument();
  // The raw os-error string is not shown.
  expect(screen.container.textContent).not.toContain('os error 17');
});

test('passes a non-"already exists" failure through verbatim', async () => {
  const screen = render(<GenericError />);
  await expect
    .element(screen.getByText(/permission denied \(os error 13\)/i))
    .toBeInTheDocument();
});
