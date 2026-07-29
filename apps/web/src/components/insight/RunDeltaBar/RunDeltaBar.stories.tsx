import type { Meta, StoryObj } from '@storybook/react-vite';

import type { InsightDeltaResult } from '../insight-delta';
import { RunDeltaBar } from './RunDeltaBar';

const DELTA: InsightDeltaResult = {
  kind: 'delta',
  delta: {
    apparentNew: 4,
    apparentResolved: 3,
    persisting: 5,
    previousRunId: 'run-prev',
    previousRunCreatedAt: 1_700_000_000_000,
    previousRunModel: 'claude-opus-4-8',
    modelChanged: false,
  },
};

const meta = {
  title: 'Insight/RunDeltaBar',
  component: RunDeltaBar,
  args: {
    result: DELTA,
    previousRunLabel: '2h ago',
  },
} satisfies Meta<typeof RunDeltaBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The headline case: a comparable predecessor, so the apparent counts render. */
export const Default: Story = {};

/** Same diff, but the predecessor ran on a different model — disclosed inline. */
export const ModelChanged: Story = {
  args: {
    result: {
      kind: 'delta',
      delta: { ...DELTA.delta, previousRunModel: 'claude-sonnet-4-6', modelChanged: true },
    } as InsightDeltaResult,
  },
};

/** Nothing changed between the two runs. */
export const NoChange: Story = {
  args: {
    result: {
      kind: 'delta',
      delta: { ...DELTA.delta, apparentNew: 0, apparentResolved: 0, persisting: 12 },
    } as InsightDeltaResult,
  },
};

/** First analysis of the project — nothing to diff against. */
export const FirstRun: Story = {
  args: {
    result: { kind: 'unavailable', blocker: 'no-earlier-run' },
    previousRunLabel: null,
  },
};

/** Earlier runs exist, but none swept comparable ground (deep vs standard, a
 *  different category set, or `diff` scope). */
export const NoComparableRun: Story = {
  args: {
    result: { kind: 'unavailable', blocker: 'no-comparable-run' },
    previousRunLabel: null,
  },
};

/** The displayed run itself can't anchor a diff (cancelled, `diff` scope, unknown
 *  depth, or the $0 usage-limit signature). */
export const RunNotDiffable: Story = {
  args: {
    result: { kind: 'unavailable', blocker: 'run-not-diffable' },
    previousRunLabel: null,
  },
};
