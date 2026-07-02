import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { RunControls } from './RunControls';
import { useRunConfig } from './RunControls.hooks';

/** Drives `RunControls` with a live `useRunConfig` so the chips, scope, and the
 *  Analyze gate are interactive in the story/test — the form state is owned here
 *  exactly as the InsightView hook owns it in the app. */
function ConfiguredRunControls({
  isStarting,
  onAnalyze,
}: {
  isStarting: boolean;
  onAnalyze: () => void;
}) {
  const config = useRunConfig(false);
  return (
    <RunControls config={config} isStarting={isStarting} onAnalyze={onAnalyze} />
  );
}

const meta = {
  title: 'Insight/RunControls',
  component: ConfiguredRunControls,
  parameters: { layout: 'fullscreen' },
  args: {
    isStarting: false,
    onAnalyze: fn(),
  },
} satisfies Meta<typeof ConfiguredRunControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Starting: Story = {
  args: { isStarting: true },
};
