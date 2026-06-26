import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { ConventionCategory } from '@/lib/bridge';
import { useRunConfig } from '@/lib/useRunConfig';
import { ALL_CATEGORIES } from '../harness.constants';
import { RunControls } from './RunControls';

/** Drives `RunControls` with a live shared `useRunConfig` so the chips, model/effort,
 *  and the Scan gate are interactive in the story/test — the form state is owned here
 *  exactly as the HarnessView hook owns it in the app. */
function ConfiguredRunControls({
  isStarting,
  onScan,
}: {
  isStarting: boolean;
  onScan: () => void;
}) {
  const config = useRunConfig<ConventionCategory>(ALL_CATEGORIES, false);
  return <RunControls config={config} isStarting={isStarting} onScan={onScan} />;
}

const meta = {
  title: 'Harness/RunControls',
  component: ConfiguredRunControls,
  parameters: { layout: 'fullscreen' },
  args: {
    isStarting: false,
    onScan: fn(),
  },
} satisfies Meta<typeof ConfiguredRunControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Starting: Story = {
  args: { isStarting: true },
};
