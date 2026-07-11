import type { Meta, StoryObj } from '@storybook/react-vite';

import { UsageHotProvider, type UsageHotWindow } from '../usage-hot';
import { TaskCardUsageChip } from './TaskCardUsageChip';

const HOT: UsageHotWindow = {
  provider: 'claude',
  windowLabel: 'Session (5h)',
  usedPercent: 93,
  resetsAt: null,
};

/** The chip reads its hot window from context, so the story provides it via
 *  `UsageHotProvider` (the same seam the app wires at the shell). */
function ChipFixture({ hot }: { hot: UsageHotWindow | null }) {
  return (
    <UsageHotProvider value={hot}>
      <div style={{ display: 'flex', padding: 16 }}>
        <TaskCardUsageChip />
      </div>
    </UsageHotProvider>
  );
}

const meta = {
  title: 'Board/TaskCardUsageChip',
  component: ChipFixture,
} satisfies Meta<typeof ChipFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Usage hot — the advisory warning chip. */
export const Hot: Story = { args: { hot: HOT } };

/** A model-scoped window over threshold names its own lane in the tooltip. */
export const ModelScoped: Story = {
  args: { hot: { ...HOT, windowLabel: 'Opus weekly', usedPercent: 96 } },
};

/** Cool / meter off — renders nothing. */
export const Cool: Story = { args: { hot: null } };
