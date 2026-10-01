import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { killCouncil, resolveCouncilConverge, startCouncil } from '@/lib/bridge';

import { CouncilReplay } from './CouncilReplay';
import { REPLAY_FIXTURE } from './CouncilReplay.stories';

// Spy the mutating Council commands, keep the rest of the bridge real. Replay must never
// call any of these — it re-renders recorded entries, it does not re-dispatch (safety #7).
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    startCouncil: vi.fn(),
    killCouncil: vi.fn(),
    resolveCouncilConverge: vi.fn(),
  };
});

/** Replay is a flex child of the view's bounded-height column in production; give it the
 *  same frame here (explicit size so the seat canvas + team chat don't overlap the
 *  controls in the headless browser). */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col" style={{ width: 1200, height: 640 }}>
      {children}
    </div>
  );
}

test('shows only READ-ONLY replay controls — no kill switch, no gavel', async () => {
  const screen = render(
    <Frame>
      <CouncilReplay transcript={REPLAY_FIXTURE} onExit={vi.fn()} />
    </Frame>,
  );

  await expect.element(screen.getByText('Replay')).toBeInTheDocument();
  await expect.element(screen.getByRole('slider', { name: 'Replay position' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Restart replay' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Exit replay' })).toBeInTheDocument();
  // Read-only: none of the ACTION controls a live run has are present.
  expect(screen.container.textContent).not.toContain('Kill council');
  expect(screen.container.textContent).not.toContain('Accept');
  expect(screen.container.textContent).not.toContain('Reject');
});

test('reconstructs the run from the transcript when scrubbed to the end', async () => {
  const screen = render(
    <Frame>
      <CouncilReplay transcript={REPLAY_FIXTURE} onExit={vi.fn()} />
    </Frame>,
  );

  // Scrub to the end (keyboard End on a range = its max) to reveal the whole run.
  const slider = screen.getByRole('slider', { name: 'Replay position' });
  await slider.click();
  await userEvent.keyboard('{End}');

  // The seat's recorded proposal (shown in the seat node AND the team chat) and the
  // terminal human verdict are reconstructed from the transcript.
  await expect.element(screen.getByText(/Write-through cache/).first()).toBeInTheDocument();
  await expect.element(screen.getByText(/Human verdict — ACCEPT/)).toBeInTheDocument();
});

test('driving the replay NEVER re-dispatches a seat or resends a command (safety #7)', async () => {
  const screen = render(
    <Frame>
      <CouncilReplay transcript={REPLAY_FIXTURE} onExit={vi.fn()} />
    </Frame>,
  );

  // Exercise every control, then scrub across the whole run.
  await screen.getByRole('button', { name: 'Restart replay' }).click();
  const slider = screen.getByRole('slider', { name: 'Replay position' });
  await slider.click();
  await userEvent.keyboard('{End}');
  await userEvent.keyboard('{Home}');

  // Not a single Council command was dispatched — replay is a pure reader.
  expect(startCouncil).not.toHaveBeenCalled();
  expect(killCouncil).not.toHaveBeenCalled();
  expect(resolveCouncilConverge).not.toHaveBeenCalled();
});

test('Exit leaves replay', async () => {
  const onExit = vi.fn();
  const screen = render(
    <Frame>
      <CouncilReplay transcript={REPLAY_FIXTURE} onExit={onExit} />
    </Frame>,
  );
  await screen.getByRole('button', { name: 'Exit replay' }).click();
  expect(onExit).toHaveBeenCalledTimes(1);
});
