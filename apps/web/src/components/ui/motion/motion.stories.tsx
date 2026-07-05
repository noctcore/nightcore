import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { m } from './index';
import { fadeRise } from './variants';

/** A card that plays the shared `fadeRise` entrance on mount. The MotionProvider
 *  comes from the global preview decorator, so `m.*` has its feature bundle. */
function FadeRiseCard() {
  return (
    <m.div
      variants={fadeRise}
      initial="initial"
      animate="animate"
      className="rounded-lg border border-border bg-card px-6 py-4 text-sm text-foreground"
    >
      A fade + rise card
    </m.div>
  );
}

const meta = {
  title: 'UI/Motion',
  component: FadeRiseCard,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof FadeRiseCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The card settles into place via transform + opacity (instant under the gate). */
export const FadeRise: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('A fade + rise card')).toBeVisible();
  },
};
