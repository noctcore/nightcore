import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { Button } from '../Button';
import {
  DetailLocation,
  DetailPanelShell,
  DetailSection,
} from './DetailPanelShell';

const meta = {
  title: 'UI/DetailPanelShell',
  component: DetailPanelShell,
  args: {
    open: true,
    label: 'Example finding',
    title: 'An example finding title',
    onClose: fn(),
    badges: (
      <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
        Medium
      </span>
    ),
    footer: <Button>Convert to task</Button>,
    children: (
      <>
        <DetailSection title="What">
          <p className="text-xs-plus2 text-muted-foreground">
            A short description of the finding.
          </p>
        </DetailSection>
        <DetailSection title="Location">
          <DetailLocation>src/app/x.ts:12-20</DetailLocation>
        </DetailSection>
      </>
    ),
  },
} satisfies Meta<typeof DetailPanelShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
