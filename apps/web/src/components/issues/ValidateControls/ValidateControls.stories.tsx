import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { EMPTY_ISSUE_TRIAGE_STREAM } from '../issue-stream';
import { ValidateControls } from './ValidateControls';

const meta = {
  title: 'Issues/ValidateControls',
  component: ValidateControls,
  args: {
    stream: EMPTY_ISSUE_TRIAGE_STREAM,
    modelSelection: {
      model: null,
      effort: null,
      providerId: null,
      onChangeModel: fn(),
      onChangeEffort: fn(),
      onChangeProviderId: fn(),
    },
    canValidate: true,
    isStarting: false,
    hasVerdict: false,
    startError: null,
    onValidate: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ValidateControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const HasVerdict: Story = { args: { hasVerdict: true } };

export const Running: Story = {
  args: {
    stream: {
      ...EMPTY_ISSUE_TRIAGE_STREAM,
      runId: 'val-1',
      issueNumber: 7,
      status: 'running',
      progressMessage: 'Investigating related files…',
    },
  },
};

export const StartError: Story = {
  args: {
    canValidate: true,
    startError: 'A validation for issue #7 is already running — cancel it first.',
  },
};
