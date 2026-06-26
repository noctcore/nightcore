import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { InsightFinding } from '../insight.types';
import { FindingGrid } from './FindingGrid';

function finding(over: Partial<InsightFinding> = {}): InsightFinding {
  return {
    id: 'f1',
    category: 'bugs',
    severity: 'high',
    effort: 'small',
    title: 'Unawaited promise drops errors',
    description: 'The handler kicks off an async write without awaiting it.',
    rationale: null,
    location: { file: 'src/a.ts', startLine: 12, endLine: null, symbol: null },
    suggestion: null,
    codeBefore: null,
    codeAfter: null,
    affectedFiles: [],
    tags: [],
    confidence: null,
    fingerprint: 'fp1',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Insight/FindingGrid',
  component: FindingGrid,
  args: {
    findings: [
      finding(),
      finding({ id: 'f2', category: 'security', severity: 'critical', title: 'Secret in log' }),
    ],
    skeletonCount: 0,
    emptyMessage: 'Run an analysis to surface findings across your codebase.',
    onOpen: fn(),
  },
} satisfies Meta<typeof FindingGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithFindings: Story = {};

export const Streaming: Story = {
  args: { findings: [finding()], skeletonCount: 3 },
};

export const Empty: Story = { args: { findings: [], skeletonCount: 0 } };
