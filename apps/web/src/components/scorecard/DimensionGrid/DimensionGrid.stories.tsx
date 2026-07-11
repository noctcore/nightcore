import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ScorecardReadingView } from '../scorecard.types';
import { DimensionGrid } from './DimensionGrid';
import type { DimensionRow } from './DimensionGrid.types';

function reading(over: Partial<ScorecardReadingView>): ScorecardReadingView {
  return {
    id: 'security-1',
    dimension: 'security',
    grade: 'C',
    title: 'Input validation is inconsistent',
    summary: 'Auth is solid but several handlers trust unvalidated bodies.',
    rationale: null,
    location: null,
    suggestion: null,
    affectedFiles: [],
    tags: [],
    findings: [],
    confidence: null,
    fingerprint: 'fp',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const ROWS: DimensionRow[] = [
  {
    dimension: 'architecture',
    state: 'done',
    reading: reading({ dimension: 'architecture', grade: 'A', title: 'Clean boundaries' }),
    trend: { previousGrade: 'B', direction: 'up', history: ['C', 'B', 'A'] },
  },
  { dimension: 'tests', state: 'running', reading: null, trend: null },
  {
    dimension: 'security',
    state: 'done',
    reading: reading({ dimension: 'security', grade: 'F', title: 'Exploitable holes', status: 'converted' }),
    trend: { previousGrade: 'C', direction: 'down', history: ['C', 'F'] },
  },
  { dimension: 'performance', state: 'pending', reading: null, trend: null },
  { dimension: 'types', state: 'error', reading: null, trend: null },
];

const meta = {
  title: 'Scorecard/DimensionGrid',
  component: DimensionGrid,
  parameters: { layout: 'fullscreen' },
  args: {
    rows: ROWS,
    emptyMessage: 'Grade the codebase to see per-dimension scores.',
    onOpen: fn(),
  },
} satisfies Meta<typeof DimensionGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { rows: [] } };
