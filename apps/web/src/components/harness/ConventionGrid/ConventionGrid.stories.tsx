import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { ConventionFindingVM } from '../harness.types';
import { ConventionGrid } from './ConventionGrid';

function finding(over: Partial<ConventionFindingVM> = {}): ConventionFindingVM {
  return {
    id: 'c1',
    category: 'folder-structure',
    kind: 'convention',
    severity: 'high',
    title: 'Folder-per-component with a colocated sibling set',
    description:
      'Every component ships its .hooks.ts, .types.ts, .stories.tsx, .test.tsx, and index.ts.',
    rationale: null,
    evidence: [
      { file: 'apps/web/src/components/board/TaskCard/TaskCard.tsx', startLine: 1, endLine: null, symbol: null },
      { file: 'apps/web/src/components/insight/RunControls/RunControls.tsx', startLine: 1, endLine: null, symbol: null },
    ],
    suggestion: null,
    tags: ['folder-per-component'],
    confidence: null,
    fingerprint: 'fp1',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/ConventionGrid',
  component: ConventionGrid,
  args: {
    findings: [
      finding(),
      finding({
        id: 'c2',
        category: 'imports-boundaries',
        kind: 'gap',
        severity: 'critical',
        title: 'No enforced cross-feature import boundary',
      }),
    ],
    skeletonCount: 0,
    emptyMessage: 'Run a scan to surface the conventions across your codebase.',
    onOpen: fn(),
  },
} satisfies Meta<typeof ConventionGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithFindings: Story = {};

export const Streaming: Story = {
  args: { findings: [finding()], skeletonCount: 3 },
};

export const Empty: Story = { args: { findings: [], skeletonCount: 0 } };
