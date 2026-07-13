import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { PortableLockExportButton } from './PortableLockExportButton';

const EXPORT = {
  stagingDir: '/proj/.nightcore/export/portable-lock',
  filesWritten: [
    '.nightcore/export/portable-lock/harness.json',
    '.nightcore/export/portable-lock/nightcore-lock.yml',
    '.nightcore/export/portable-lock/README.md',
  ],
  workflowYaml:
    'name: structure-lock\non: [push, pull_request]\n      - run: npx --yes @noctcore/harness@0.1.0 check\n',
  runnerVersion: '0.1.0',
};

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const writeText = vi.fn(async () => {});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'export_portable_lock' ? Promise.resolve(EXPORT) : Promise.resolve(undefined),
  );
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('opens the preview dialog and does NOT write until the user confirms', async () => {
  const screen = render(<PortableLockExportButton projectPath="/proj" />);
  await screen.getByRole('button', { name: /export portable lock/i }).click();

  // The preview dialog opens with the manual-step instruction…
  await expect
    .element(screen.getByRole('heading', { name: /export portable lock/i }))
    .toBeInTheDocument();
  await expect.element(screen.getByText(/one manual step/i)).toBeInTheDocument();
  // …but no export has been written yet (the write is behind the confirm button).
  expect(invoke).not.toHaveBeenCalledWith('export_portable_lock', expect.anything());
});

test('stages the bundle on confirm and shows the workflow with a copy affordance', async () => {
  const screen = render(<PortableLockExportButton projectPath="/proj" />);
  await screen.getByRole('button', { name: /export portable lock/i }).click();
  await screen.getByRole('button', { name: /export bundle/i }).click();

  // The command is invoked with the active project path.
  expect(invoke).toHaveBeenCalledWith('export_portable_lock', { projectPath: '/proj' });

  // The result state shows the staging path + the copy button + the done affordance.
  await expect.element(screen.getByText(EXPORT.stagingDir)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();

  // Copy writes the workflow YAML to the clipboard and flips the label.
  await screen.getByRole('button', { name: /^copy$/i }).click();
  expect(writeText).toHaveBeenCalledWith(EXPORT.workflowYaml);
  await expect.element(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
});

test('is disabled with no active project (null projectPath) and never opens the dialog', async () => {
  const screen = render(<PortableLockExportButton projectPath={null} />);
  const button = screen.getByRole('button', { name: /export portable lock/i });
  await expect.element(button).toBeDisabled();
  expect(invoke).not.toHaveBeenCalledWith('export_portable_lock', expect.anything());
});
