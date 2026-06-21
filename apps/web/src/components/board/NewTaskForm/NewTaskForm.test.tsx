import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import * as stories from './NewTaskForm.stories';

const { Default } = composeStories(stories);

test('gates create on a non-empty title, then fires onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  const create = screen.getByRole('button', { name: /create task/i });
  await expect.element(create).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Task title').element(), 'Add a panel');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith('Add a panel', '', 'build', 'main');
});
