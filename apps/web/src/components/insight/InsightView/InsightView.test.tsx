import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock only the raw Tauri IPC boundary — `startAnalysis` calls `invoke` directly
// (not the outside-Tauri-safe `tauriInvoke` wrapper), so exercising a real Analyze
// click needs this to resolve instead of rejecting. Every other bridge command in
// this view goes through `tauriInvoke`, which already no-ops outside Tauri (no
// `__TAURI_INTERNALS__` global is set here), so this mock is scoped to exactly the
// one call these tests care about.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
invoke.mockResolvedValue('run-abc');

import * as stories from './InsightView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the Insight header for an active project', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByRole('heading', { name: 'Insight' })).toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('shows the CONFIGURE screen with the Analyze control when idle', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText('Run config')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /^analyze$/i })).toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});

test('a standard-mode Analyze sends deep: null', async () => {
  invoke.mockClear();
  const screen = render(<Idle />);
  await screen.getByRole('button', { name: /^analyze$/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'start_analysis',
      expect.objectContaining({ deep: null }),
    ),
  );
});

test('the Deep toggle sends explicit deep params (never zero-defaulted)', async () => {
  invoke.mockClear();
  const screen = render(<Idle />);
  await screen.getByRole('radio', { name: /^deep$/i }).click();
  await screen.getByRole('button', { name: /^analyze$/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'start_analysis',
      expect.objectContaining({
        // Explicit values, not an empty `{}` — the generated Rust `DeepScanConfig`
        // fields default to 0 on deserialize, so an omitted field would silently
        // zero the round count / cap and produce a 0-round scan.
        deep: {
          maxRoundsPerCategory: 15,
          convergenceEmptyRounds: 2,
          maxFindingsPerRound: 20,
        },
      }),
    ),
  );
});
