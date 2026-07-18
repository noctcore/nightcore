import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { GitStateRow } from './GitStateRow';

const meta = {
  title: 'NewProject/GitStateRow',
  component: GitStateRow,
  args: { gitState: 'valid', onInitGit: fn() },
} satisfies Meta<typeof GitStateRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A valid git repo — the success label + check icon. */
export const Valid: Story = {};

/** Detection in flight — spinner + "Checking…". */
export const Checking: Story = { args: { gitState: 'checking' } };

/** Not a repo — warning label + the `git init` recovery action. */
export const NotARepo: Story = { args: { gitState: 'invalid' } };
