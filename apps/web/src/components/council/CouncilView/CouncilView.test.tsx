import { composeStories } from '@storybook/react-vite';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import { killCouncil, startCouncil } from '@/lib/bridge';

import { CouncilView } from './CouncilView';
import * as stories from './CouncilView.stories';

const { Idle, NoProject } = composeStories(stories);

// Spy start/kill so the kill switch can be asserted end-to-end; keep the rest real
// (outside Tauri `startCouncil` no-ops, so the run stays `running` for the kill).
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    startCouncil: vi.fn(async () => {}),
    killCouncil: vi.fn(async () => {}),
  };
});

afterEach(() => {
  vi.mocked(startCouncil).mockClear();
  vi.mocked(killCouncil).mockClear();
});

test('an active project shows the Council header and the convene start panel', async () => {
  const screen = render(<Idle />);
  await expect
    .element(screen.getByRole('heading', { name: 'Council', level: 1 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Convene a council' }))
    .toBeInTheDocument();
});

test('no active project shows the no-project empty state', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});

test('the kill switch is surfaced while live and halts the run (safety #4)', async () => {
  const screen = render(
    <ToastProvider>
      <CouncilView projectPath="/Users/dev/acme" projectName="acme" />
    </ToastProvider>,
  );

  // Convene a council — the run goes live.
  await screen.getByLabelText('Objective').fill('Compare two migration strategies.');
  await screen.getByRole('button', { name: /Convene council/ }).click();
  expect(startCouncil).toHaveBeenCalledTimes(1);

  // The kill switch is a prominent, labeled control that appears the moment a run is live.
  const kill = screen.getByRole('button', { name: 'Kill council' });
  await expect.element(kill).toBeInTheDocument();
  await kill.click();

  // It dispatches the kill and the board reflects the stopped run.
  expect(killCouncil).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText('Stopped')).toBeInTheDocument();
});
