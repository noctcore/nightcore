import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import * as stories from './NewProjectDialog.stories';

const { NoFolder, FolderChosen, NotAGitRepo } = composeStories(stories);

test('disables create until a folder is chosen', async () => {
  const screen = render(<NoFolder />);
  await expect
    .element(screen.getByRole('button', { name: /create project/i }))
    .toBeDisabled();
});

test('enables create once a folder and name are present, then emits the draft', async () => {
  const onCreate = vi.fn();
  const screen = render(<FolderChosen onCreate={onCreate} />);
  const create = screen.getByRole('button', { name: /create project/i });
  await expect.element(create).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Project name').element(), 'my-project');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ folder: '~/dev/my-project', name: 'my-project' }),
  );
});

test('gates create and offers git init when the folder is not a repo', async () => {
  const onInitGit = vi.fn();
  const screen = render(<NotAGitRepo onInitGit={onInitGit} />);
  await userEvent.type(screen.getByLabelText('Project name').element(), 'my-project');
  // Even with a name, create stays disabled until the folder is a git repo.
  await expect
    .element(screen.getByRole('button', { name: /create project/i }))
    .toBeDisabled();
  await screen.getByText('git init').click();
  expect(onInitGit).toHaveBeenCalled();
});
