import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { portaledSurface } from '../../../../.storybook/test-utils';
import { NewProjectDialog } from './NewProjectDialog';

const meta = {
  title: 'NewProject/NewProjectDialog',
  component: NewProjectDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    models: ['Opus 4.8', 'Sonnet 4.5', 'Haiku 4'],
    onChooseFolder: fn(),
    onCreate: fn(),
    onClose: fn(),
    onInitGit: fn(),
    folder: null,
    gitState: 'unknown',
  },
} satisfies Meta<typeof NewProjectDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No folder chosen yet — create is disabled. */
export const NoFolder: Story = {};

/** Folder chosen and a valid git repo — ready to name and create. */
export const FolderChosen: Story = {
  args: { folder: '~/dev/my-project', gitState: 'valid' },
};

/** Folder chosen but not a git repo — create is gated, `git init` is offered. */
export const NotAGitRepo: Story = {
  args: { folder: '~/dev/not-a-repo', gitState: 'invalid' },
};

/** Play test: create stays disabled until a folder + name + valid git repo. */
export const CreatesProject: Story = {
  args: { folder: '~/dev/my-project', gitState: 'valid' },
  play: async ({ args }) => {
    const canvas = portaledSurface();
    const create = canvas.getByRole('button', { name: /create project/i });
    // Folder present but name empty → still disabled.
    await expect(create).toBeDisabled();

    await userEvent.type(canvas.getByLabelText('Project name'), 'my-project');
    await expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ folder: '~/dev/my-project', name: 'my-project' }),
      ),
    );
  },
};
