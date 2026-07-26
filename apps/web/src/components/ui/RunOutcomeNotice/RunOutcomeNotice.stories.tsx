import type { Meta, StoryObj } from '@storybook/react-vite';

import { RunOutcomeNotice } from './RunOutcomeNotice';

const meta = {
  title: 'UI/RunOutcomeNotice',
  component: RunOutcomeNotice,
  parameters: { layout: 'padded' },
  args: { kind: 'failed', message: 'Analysis failed: provider returned 503.' },
} satisfies Meta<typeof RunOutcomeNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A failed run — destructive card with the reassurance line. */
export const Failed: Story = {};

/** A user cancel — neutral card, no reassurance line. */
export const Aborted: Story = {
  args: {
    kind: 'aborted',
    message:
      'Analysis cancelled. Any findings gathered before you stopped are shown below.',
  },
};

/** A run that COMPLETED with a failed stage inside it — warning card, caller-owned
 *  message. The scan's findings are real; its synthesis produced nothing (#401). */
export const Partial: Story = {
  args: {
    kind: 'partial',
    message:
      'Synthesis failed: model returned no parseable plan. The conventions below were detected normally, but no artifacts or proposals could be generated — re-run the scan to retry synthesis.',
  },
};
