import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { EMPTY_INSIGHT_STREAM } from '../insight-stream';
import { RunControls } from './RunControls';

const meta = {
  title: 'Insight/RunControls',
  component: RunControls,
  args: {
    stream: EMPTY_INSIGHT_STREAM,
    isStarting: false,
    disabled: false,
    onAnalyze: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof RunControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Running: Story = {
  args: {
    stream: {
      ...EMPTY_INSIGHT_STREAM,
      runId: 'run-1',
      status: 'running',
      costUsd: 0.042,
      usage: { inputTokens: 1200, outputTokens: 800 },
    },
  },
};
