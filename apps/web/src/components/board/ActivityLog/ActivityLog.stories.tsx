import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  EMPTY_STREAM,
  type SessionGroup,
  type SessionPhase,
  type SessionStream,
} from '../session-stream';
import { ActivityLog } from './ActivityLog';

/** Assemble session groups from per-session (phase, stream) pairs. */
function sessions(
  parts: Array<{ phase: SessionPhase; model?: string; stream: Partial<SessionStream> }>,
): SessionGroup[] {
  return parts.map((p, i) => ({
    index: i + 1,
    sdkSessionId: null,
    model: p.model ?? null,
    prompt: null,
    phase: p.phase,
    stream: { ...EMPTY_STREAM, ...p.stream },
  }));
}

const meta = {
  title: 'Board/ActivityLog',
  component: ActivityLog,
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityLog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No transcript yet — the empty, not-running prompt to run the task. */
export const Empty: Story = {
  args: { sessions: [], isRunning: false },
};

/** A live run with no tokens yet — the running empty state. */
export const WaitingForToken: Story = {
  args: { sessions: [], isRunning: true },
};

/** A single session renders inline with no collapsible chrome. */
export const SingleSession: Story = {
  args: {
    isRunning: false,
    sessions: sessions([
      {
        phase: 'build',
        model: 'claude-opus-4-8',
        stream: {
          entries: [
            {
              kind: 'text',
              id: 1,
              closed: true,
              markdown: 'Adding the auth middleware and wiring it into the router.',
            },
            { kind: 'tool', id: 1, toolName: 'Edit', input: { file_path: 'src/auth/guard.ts' } },
            { kind: 'tool', id: 2, toolName: 'Bash', input: { command: 'bun test auth' } },
          ],
          toolSeq: 2,
          toolCount: 2,
          costUsd: 0.42,
        },
      },
    ]),
  },
};

/** Multiple sessions render as collapsible blocks; the latest opens by default. */
export const MultiSession: Story = {
  args: {
    isRunning: false,
    sessions: sessions([
      {
        phase: 'build',
        model: 'claude-opus-4-8',
        stream: {
          entries: [
            {
              kind: 'text',
              id: 1,
              closed: true,
              markdown: 'Adding the auth middleware and wiring it into the router.',
            },
            { kind: 'tool', id: 1, toolName: 'Edit', input: { file_path: 'src/auth/guard.ts' } },
          ],
          toolSeq: 1,
          toolCount: 1,
          costUsd: 0.42,
        },
      },
      {
        phase: 'verify',
        model: 'claude-sonnet-4-6',
        stream: {
          entries: [
            {
              kind: 'text',
              id: 1,
              closed: true,
              markdown: 'Reviewing the diff against the base branch — checks pass.',
            },
            { kind: 'tool', id: 1, toolName: 'Bash', input: { command: 'git diff main' } },
          ],
          toolSeq: 1,
          toolCount: 1,
          costUsd: 0.12,
        },
      },
    ]),
  },
};

/** A session whose stream carries a terminal error replaces the timeline. */
export const WithError: Story = {
  args: {
    isRunning: false,
    sessions: sessions([
      {
        phase: 'build',
        stream: { error: "cannot resolve 'sass-loader'" },
      },
    ]),
  },
};
