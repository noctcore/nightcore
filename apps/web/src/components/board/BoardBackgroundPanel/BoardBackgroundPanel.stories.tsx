import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { DEFAULT_APPEARANCE } from '../appearance';
import { BoardBackgroundPanel } from './BoardBackgroundPanel';

/** A 1×1 translucent PNG standing in for a user's background image in the preview. */
const SAMPLE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const meta = {
  title: 'Board/BoardBackgroundPanel',
  component: BoardBackgroundPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    appearance: DEFAULT_APPEARANCE,
    backgroundUrl: null,
    onChangeAppearance: fn(),
    onPickImage: fn(),
    onClearImage: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof BoardBackgroundPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No background set yet: the empty preview + "Choose Image", no Clear. */
export const NoBackground: Story = {};

/** A background image is set, with a translucent, glassy appearance dialed in. */
export const WithBackground: Story = {
  args: {
    backgroundUrl: SAMPLE_IMAGE,
    appearance: {
      cardOpacity: 0.5,
      columnOpacity: 0.5,
      showColumnBorders: true,
      showCardBorders: true,
      cardGlassmorphism: true,
      cardBorderOpacity: 0.82,
      hideBoardScrollbar: false,
    },
  },
};
