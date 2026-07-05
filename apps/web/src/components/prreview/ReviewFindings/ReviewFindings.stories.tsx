import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ReviewFindingView } from '../prreview.types';
import { ReviewFindings } from './ReviewFindings';

function finding(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: 12,
    title: 'Unawaited promise drops errors',
    body: 'The handler kicks off an async write without awaiting it.',
    suggestedFix: 'await save();',
    fingerprint: 'fp1',
    corroboratedBy: [],
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'PrReview/ReviewFindings',
  component: ReviewFindings,
  args: {
    findings: [
      finding({
        id: 'f1',
        severity: 'critical',
        lens: 'security',
        title: 'Secret in log line',
        // Two other lenses independently flagged it → corroboration chip.
        corroboratedBy: ['logic', 'tests'],
      }),
      finding({ id: 'f2', severity: 'high', title: 'Unawaited promise drops errors' }),
      finding({ id: 'f3', severity: 'low', lens: 'tests', title: 'Missing edge-case test' }),
    ],
    emptyMessage: 'Review a pull request to surface findings across lenses.',
    selection: new Set(['f1']),
    onToggleSelect: fn(),
    onSelectionChange: fn(),
    onOpen: fn(),
  },
} satisfies Meta<typeof ReviewFindings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {};

export const Empty: Story = {
  args: { findings: [], selection: new Set() },
};
