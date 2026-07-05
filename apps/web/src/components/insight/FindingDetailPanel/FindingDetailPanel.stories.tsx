import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { InsightFinding } from '../insight.types';
import { FindingDetailPanel } from './FindingDetailPanel';

function finding(over: Partial<InsightFinding> = {}): InsightFinding {
  return {
    id: 'f1',
    category: 'bugs',
    severity: 'high',
    effort: 'small',
    title: 'Unawaited promise drops errors',
    description: 'The handler kicks off an async write without awaiting it.',
    rationale: 'A rejected write is swallowed, so the user never sees the failure.',
    location: { file: 'src/a.ts', startLine: 12, endLine: 18, symbol: 'save' },
    suggestion: 'Await the write and surface the error.',
    codeBefore: 'void save();',
    codeAfter: 'await save();',
    affectedFiles: ['src/a.ts'],
    tags: ['async'],
    confidence: 0.8,
    fingerprint: 'fp1',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Insight/FindingDetailPanel',
  component: FindingDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
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
  args: {
    finding: finding({
      status: 'converted',
      linkedTaskId: 't1',
      codeBefore: null,
      codeAfter: null,
    }),
  },
};

export const Dismissed: Story = {
  args: { finding: finding({ status: 'dismissed' }) },
};
