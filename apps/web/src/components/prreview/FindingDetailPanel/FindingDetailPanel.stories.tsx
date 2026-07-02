import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ReviewFindingView } from '../prreview.types';
import { FindingDetailPanel } from './FindingDetailPanel';

function finding(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: 12,
    title: 'Unawaited promise drops errors',
    body: 'The handler kicks off an async write without awaiting it, so a rejected write is swallowed and the user never sees the failure.',
    suggestedFix: 'await save();',
    fingerprint: 'fp1',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'PrReview/FindingDetailPanel',
  component: FindingDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    finding: finding(),
    pending: false,
    onClose: fn(),
    onConvert: fn(),
    onDismiss: fn(),
    onRestore: fn(),
    onGotoBoard: fn(),
  },
} satisfies Meta<typeof FindingDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Converted: Story = {
  args: { finding: finding({ status: 'converted', linkedTaskId: 't1' }) },
};

export const Dismissed: Story = {
  args: { finding: finding({ status: 'dismissed' }) },
};
