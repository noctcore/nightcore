import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { RunControls } from './RunControls';
import { useRunConfig } from './RunControls.hooks';

/** Drives `RunControls` with a live `useRunConfig` so the dimension chips and the
 *  Grade gate are interactive in the story/test — the form state is owned here
 *  exactly as the ScorecardView hook owns it in the app. */
function ConfiguredRunControls({
  isStarting,
  onGrade,
}: {
  isStarting: boolean;
  onGrade: () => void;
}) {
  const config = useRunConfig(false);
  return <RunControls config={config} isStarting={isStarting} onGrade={onGrade} />;
}

const meta = {
  title: 'Scorecard/RunControls',
  component: ConfiguredRunControls,
  parameters: { layout: 'fullscreen' },
  args: {
    isStarting: false,
    onGrade: fn(),
  },
} satisfies Meta<typeof ConfiguredRunControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Starting: Story = {
  args: { isStarting: true },
};
