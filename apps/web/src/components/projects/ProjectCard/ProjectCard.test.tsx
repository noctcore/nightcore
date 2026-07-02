import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectCard.stories';

const { Live, Idle } = composeStories(stories);

test('shows the live badge for a running project', async () => {
  const screen = render(<Live />);
  await expect.element(screen.getByText('live')).toBeInTheDocument();
});

test('calls onOpen with the project id from the identity affordance', async () => {
  const onOpen = vi.fn();
  const screen = render(<Idle onOpen={onOpen} />);
  await screen.getByText('automaker (legacy)').click();
  expect(onOpen).toHaveBeenCalledWith('automaker');
});

test('the kebab opens a menu instead of deleting immediately', async () => {
  const onDelete = vi.fn();
  const screen = render(<Live onDelete={onDelete} />);
  await screen.getByRole('button', { name: 'Project menu' }).click();
  await expect.element(screen.getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  expect(onDelete).not.toHaveBeenCalled();
});

test('Remove routes through a confirmation before deleting', async () => {
  const onDelete = vi.fn();
  const screen = render(<Live onDelete={onDelete} />);
  await screen.getByRole('button', { name: 'Project menu' }).click();
  await screen.getByRole('menuitem', { name: 'Remove' }).click();
  // The destructive action is not fired until the dialog is confirmed.
  expect(onDelete).not.toHaveBeenCalled();
  await screen.getByRole('button', { name: 'Remove' }).click();
  expect(onDelete).toHaveBeenCalledWith('nightcore');
});

test('Rename submits the edited name', async () => {
  const onRename = vi.fn();
  const screen = render(<Live onRename={onRename} />);
  await screen.getByRole('button', { name: 'Project menu' }).click();
  await screen.getByRole('menuitem', { name: 'Rename' }).click();
  const input = screen.getByLabelText('Project name');
  await userEvent.fill(input.element() as HTMLInputElement, 'renamed-core');
  await screen.getByRole('button', { name: 'Save' }).click();
  expect(onRename).toHaveBeenCalledWith('nightcore', 'renamed-core');
});
