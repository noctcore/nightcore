import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ReviewFindingView } from '../prreview.types';
import { ValidatorDrops } from './ValidatorDrops';

function dropped(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'd1',
    lens: 'security',
    severity: 'high',
    file: 'src/main.rs',
    line: 42,
    title: 'Unvalidated path joins user input',
    body: 'b',
    suggestedFix: null,
    fingerprint: 'fp-d1',
    corroboratedBy: [],
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'PrReview/ValidatorDrops',
  component: ValidatorDrops,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
  args: { dropped: [dropped()] },
} satisfies Meta<typeof ValidatorDrops>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One dropped finding — collapsed by default (the drops are an audit trail). */
export const OneDrop: Story = {};

/** Several drops across lenses and severities. */
export const ManyDrops: Story = {
  args: {
    dropped: [
      dropped(),
      dropped({
        id: 'd2',
        lens: 'tests',
        severity: 'low',
        file: 'src/lib.rs',
        line: null,
        title: 'No regression test for the new branch',
      }),
      dropped({
        id: 'd3',
        lens: 'logic',
        severity: 'medium',
        file: 'src/parse.rs',
        line: 7,
        title: 'Off-by-one in the slice bound',
      }),
    ],
  },
};

/** The validator dropped nothing — the disclosure self-hides. */
export const NoDrops: Story = { args: { dropped: [] } };
