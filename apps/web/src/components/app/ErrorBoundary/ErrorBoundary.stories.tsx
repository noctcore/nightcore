import type { Meta, StoryObj } from '@storybook/react-vite';
import { ErrorBoundary } from './ErrorBoundary';

/** A child that throws on render, to exercise the boundary's fallback. */
function Boom(): never {
  throw new Error('Simulated render crash');
}

const meta = {
  title: 'App/ErrorBoundary',
  component: ErrorBoundary,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Healthy tree: the boundary is transparent and renders its children. */
export const Healthy: Story = {
  args: {
    children: <p style={{ padding: 24 }}>Everything is fine.</p>,
  },
};

/** A child throws: the boundary catches it and shows the recoverable fallback. */
export const Caught: Story = {
  args: {
    children: <Boom />,
  },
};
