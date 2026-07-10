import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makePreview } from '../IssueMapDialog/IssueMapDialog.fixtures';
import { IssueMapExportButton } from './IssueMapExportButton';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'preview_issue_map' ? Promise.resolve(makePreview()) : Promise.resolve(undefined),
  );
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('opens the IssueMapDialog on click and mints no task (no convert command)', async () => {
  const screen = render(<IssueMapExportButton scanKind="insight" runId="run-abc" />);
  await screen.getByRole('button', { name: /export to github/i }).click();
  // The dialog opens and fetches its preview.
  await expect
    .element(screen.getByRole('heading', { name: /export to github/i }))
    .toBeInTheDocument();
  // Export is orthogonal to convert-to-task — no convert command is ever invoked.
  expect(invoke).not.toHaveBeenCalledWith('convert_finding_to_task', expect.anything());
  expect(invoke).not.toHaveBeenCalledWith('convert_reading_to_task', expect.anything());
});

test('is disabled with no completed run (null runId) and never opens the dialog', async () => {
  const screen = render(<IssueMapExportButton scanKind="insight" runId={null} />);
  const button = screen.getByRole('button', { name: /export to github/i });
  await expect.element(button).toBeDisabled();
  expect(invoke).not.toHaveBeenCalledWith('preview_issue_map', expect.anything());
});
