import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Spy the projection poll; the hook's real ~1s focus debounce (useWindowFocusPoll) runs.
const pollIssueStates = vi.fn<() => Promise<[number, string][]>>();
vi.mock('@/lib/bridge', () => ({ pollIssueStates: () => pollIssueStates() }));

import { useIssueStatePoll } from './useIssueStatePoll.hooks';

function Harness({ enabled }: { enabled: boolean }) {
  useIssueStatePoll(enabled);
  return null;
}

afterEach(() => {
  pollIssueStates.mockReset();
  vi.useRealTimers();
});

test('polls upstream state on window focus after the debounce when enabled', () => {
  pollIssueStates.mockResolvedValue([]);
  render(<Harness enabled />);
  vi.useFakeTimers();

  window.dispatchEvent(new Event('focus'));
  expect(pollIssueStates).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(pollIssueStates).toHaveBeenCalledTimes(1);
});

test('is inert when disabled — a focus never polls', () => {
  render(<Harness enabled={false} />);
  vi.useFakeTimers();
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(1000);
  expect(pollIssueStates).not.toHaveBeenCalled();
});
