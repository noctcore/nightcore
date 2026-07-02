import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ScorecardReadingView } from '../scorecard.types';
import { ReadingDetailPanel } from './ReadingDetailPanel';

const READING: ScorecardReadingView = {
  id: 'security-1',
  dimension: 'security',
  grade: 'C',
  title: 'Input validation is inconsistent',
  summary: 'Auth is solid but several handlers trust unvalidated request bodies.',
  rationale: 'Validate every server-fn boundary with zod to reach a B.',
  location: { file: 'src/fn/user.ts', startLine: 12, endLine: 20, symbol: 'updateUser' },
  suggestion: 'Add zod validation at the handler boundary.',
  affectedFiles: ['src/fn/user.ts', 'src/fn/order.ts'],
  tags: ['cwe-20'],
  findings: [
    {
      detail: 'updateUser trusts req.body.id without an ownership check',
      location: { file: 'src/fn/user.ts', startLine: 14, endLine: null, symbol: null },
    },
  ],
  confidence: 0.7,
  fingerprint: 'fp',
  status: 'open',
  linkedTaskId: null,
};

const meta = {
  title: 'Scorecard/ReadingDetailPanel',
  component: ReadingDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    reading: READING,
    pending: false,
    onClose: fn(),
    onHarden: fn(),
    onGotoBoard: fn(),
  },
} satisfies Meta<typeof ReadingDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hardened: Story = {
  args: { reading: { ...READING, status: 'converted', linkedTaskId: 'task-1' } },
};
