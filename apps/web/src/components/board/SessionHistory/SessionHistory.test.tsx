import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './SessionHistory.stories';
import {
  extractMessageText,
  formatTimestamp,
  sessionTitle,
} from './SessionHistory.hooks';
import { SESSIONS } from '../_fixtures';

const { Default, Empty, ResumeDisabled } = composeStories(stories);

test('renders a row per past session with its title', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText(/Wire up the auth guard/)).toBeInTheDocument();
  // The custom-titled session shows its custom title, not the auto-summary.
  await expect.element(screen.getByText('Guard v1 (keep)')).toBeInTheDocument();
});

test('badges an orphaned session whose worktree was pruned', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText(/orphaned \(worktree pruned\)/)).toBeInTheDocument();
});

test('offers Resume only for a live-cwd session, not an orphaned one', async () => {
  const screen = render(<Default />);
  // Wait for the list to load.
  await expect.element(screen.getByText(/Wire up the auth guard/)).toBeInTheDocument();
  const resumeButtons = screen.container.querySelectorAll('button[aria-label="Resume session"]');
  // 2 live-cwd sessions are resumable; the 1 orphaned one is not.
  expect(resumeButtons).toHaveLength(2);
});

test('hides Resume entirely when the task cannot resume', async () => {
  const screen = render(<ResumeDisabled />);
  await expect.element(screen.getByText(/Wire up the auth guard/)).toBeInTheDocument();
  const resumeButtons = screen.container.querySelectorAll('button[aria-label="Resume session"]');
  expect(resumeButtons).toHaveLength(0);
});

test('fires onResume(taskId, sdkSessionId) when Resume is clicked', async () => {
  const onResume = vi.fn();
  const screen = render(<Default onResume={onResume} />);
  await expect.element(screen.getByText(/Wire up the auth guard/)).toBeInTheDocument();
  const firstResume = screen.container.querySelector('button[aria-label="Resume session"]');
  (firstResume as HTMLButtonElement).click();
  expect(onResume).toHaveBeenCalledWith('task-1', 'sdk-uuid-live');
});

test('shows the empty state when there are no past sessions', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText(/No past sessions yet/)).toBeInTheDocument();
});

test('sessionTitle prefers the custom title, then summary, then first prompt', () => {
  expect(sessionTitle(SESSIONS[2]!)).toBe('Guard v1 (keep)');
  expect(sessionTitle(SESSIONS[0]!)).toBe('Wire up the auth guard middleware');
  expect(
    sessionTitle({
      sdkSessionId: 'abcdef1234',
      summary: '',
      lastModified: 0,
      customTitle: null,
      firstPrompt: null,
      orphaned: false,
    }),
  ).toBe('Session abcdef12');
});

test('extractMessageText joins text blocks and tolerates a string content', () => {
  expect(extractMessageText({ role: 'user', content: 'hi there' })).toBe('hi there');
  expect(
    extractMessageText({
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'tool_use', id: 't', name: 'Bash', input: {} },
        { type: 'text', text: 'two' },
      ],
    }),
  ).toBe('one\n\ntwo');
  // A pure tool-use turn has no text.
  expect(extractMessageText({ role: 'assistant', content: [{ type: 'tool_use' }] })).toBe('');
});

test('formatTimestamp returns empty for a missing/invalid value', () => {
  expect(formatTimestamp(null)).toBe('');
  expect(formatTimestamp(undefined)).toBe('');
  expect(formatTimestamp(Number.NaN)).toBe('');
  expect(formatTimestamp(1_718_900_000_000)).not.toBe('');
});
