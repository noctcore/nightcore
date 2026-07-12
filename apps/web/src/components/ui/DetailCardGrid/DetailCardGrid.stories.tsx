import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { DetailCard } from './DetailCard';
import { DetailCardGrid } from './DetailCardGrid';

const badge = (
  <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
    Medium
  </span>
);

const cards = (
  <>
    <DetailCard
      onClick={fn()}
      badges={badge}
      title="An example finding"
      location="src/app/x.ts:12-20"
      description="A short description that explains the finding in a line or two."
    />
    <DetailCard
      onClick={fn()}
      dimmed
      hoverTitle="Dismissed"
      badges={badge}
      title="A dismissed finding"
      description="This one is dismissed, so its title and body render muted."
    />
  </>
);

const meta = {
  title: 'UI/DetailCardGrid',
  component: DetailCardGrid,
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', height: 360 }}>
        <Story />
      </div>
    ),
  ],
  args: { isEmpty: false, emptyMessage: 'Nothing to show yet.', skeletonCount: 0 },
} satisfies Meta<typeof DetailCardGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithCards: Story = { args: { children: cards } };

/** A pass still streaming appends skeleton placeholders and marks the grid busy. */
export const Streaming: Story = { args: { children: cards, skeletonCount: 3 } };

export const Empty: Story = { args: { isEmpty: true, children: null } };
