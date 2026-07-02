import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './NewTaskForm.stories';

const { Default } = composeStories(stories);

test('gates create on a non-empty title, then fires onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  const create = screen.getByRole('button', { name: /create task/i });
  await expect.element(create).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Title').element(), 'Add a panel');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith('Add a panel', '', 'build', 'main', {
    permissionMode: null,
    model: null,
    effort: null,
    maxTurns: null,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('threads an explicit max-turns ceiling through onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText('Title').element(), 'Bounded run');
  await userEvent.type(screen.getByLabelText('Max turns').element(), '40');
  await screen.getByRole('button', { name: /create task/i }).click();

  expect(onCreate).toHaveBeenCalledWith('Bounded run', '', 'build', 'main', {
    permissionMode: null,
    model: null,
    effort: null,
    maxTurns: 40,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});
