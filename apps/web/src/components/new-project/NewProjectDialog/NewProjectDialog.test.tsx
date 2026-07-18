import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { projectNameFromPath } from './NewProjectDialog.hooks';
import * as stories from './NewProjectDialog.stories';

const { NoFolder, FolderChosen, NotAGitRepo } = composeStories(stories);

test.each([
  ['X:\\dev\\nightcore', 'nightcore'],
  ['/home/me/nightcore/', 'nightcore'],
  ['X:\\dev\\nightcore\\.git', 'nightcore'],
  ['/home/me/nightcore/.git/', 'nightcore'],
])('derives a project name from %s', (path, expected) => {
  expect(projectNameFromPath(path)).toBe(expected);
});

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
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('my-project');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ folder: '~/dev/my-project', name: 'my-project' }),
  );
});

test('submits on plain Enter in the name field once creatable', async () => {
  const onCreate = vi.fn();
  const screen = render(<FolderChosen onCreate={onCreate} />);
  const input = screen.getByLabelText('Project name');
  await expect.element(input).toHaveValue('my-project');
  await userEvent.type(input.element(), '{Enter}');
  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ folder: '~/dev/my-project', name: 'my-project' }),
  );
});

test('does not replace a manually edited name when the folder changes', async () => {
  const screen = render(<FolderChosen />);
  const input = screen.getByLabelText('Project name');
  await expect.element(input).toHaveValue('my-project');
  await userEvent.clear(input.element());
  await userEvent.type(input.element(), 'custom-name');
  await screen.rerender(
    <FolderChosen folder="C:\\different\\repository" gitState="valid" />,
  );
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('custom-name');
});

test('includes a selected preset icon in the create draft', async () => {
  const onCreate = vi.fn();
  const screen = render(<FolderChosen onCreate={onCreate} />);

  await screen.getByRole('button', { name: 'Rocket' }).click();
  await screen.getByRole('button', { name: /create project/i }).click();

  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ icon: 'Rocket', customImage: null }),
  );
});

test('gates create and offers git init when the folder is not a repo', async () => {
  const onInitGit = vi.fn();
  const screen = render(<NotAGitRepo onInitGit={onInitGit} />);
  // Even with a name, create stays disabled until the folder is a git repo.
  await expect
    .element(screen.getByRole('button', { name: /create project/i }))
    .toBeDisabled();
  await screen.getByText('git init').click();
  expect(onInitGit).toHaveBeenCalled();
});
