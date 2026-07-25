import type { Meta, StoryObj } from '@storybook/react-vite';

import { EvidenceList } from './EvidenceList';

const meta = {
  title: 'UI/EvidenceList',
  component: EvidenceList,
  parameters: { layout: 'padded' },
  args: {
    items: [
      {
        detail: 'No error boundary wraps the route loader',
        location: { file: 'src/routes/board.tsx', startLine: 42, endLine: 51, symbol: 'BoardRoute' },
      },
      {
        location: { file: 'src/lib/formatters.ts', startLine: 21, endLine: null, symbol: 'formatLocation' },
      },
      { detail: 'Retry has no backoff', location: null },
    ],
  },
} satisfies Meta<typeof EvidenceList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mixed rows: detail + location, location-only, and detail-only. */
export const Default: Story = {};

/** The Harness convention shape — location-only anchors, no human detail. */
export const LocationOnly: Story = {
  args: {
    items: [
      { location: { file: 'src/components/board/TaskCard/TaskCard.tsx', startLine: 12, endLine: 40, symbol: null } },
      { location: { file: 'src/lib/scan-run/deep.ts', startLine: 9, endLine: null, symbol: 'deepModeMeta' } },
    ],
  },
};
