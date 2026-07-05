import { userEvent } from '@vitest/browser/context';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import { Modal } from './Modal';

function Body() {
  return (
    <div className="p-4">
      <button data-first>First</button>
      <input aria-label="middle" />
      <button data-last>Last</button>
    </div>
  );
}

/** Every render goes through MotionProvider (LazyMotion + reduced-motion config),
 *  mirroring the app root, so the panel's `m.*` / `AnimatePresence` behave exactly
 *  as they do live. Motion is made instant under the gate via
 *  `MotionGlobalConfig.skipAnimations` (see .storybook/vitest.setup.ts). */
function renderModal(ui: React.ReactElement) {
  return render(<MotionProvider>{ui}</MotionProvider>);
}

test('Escape routes to onClose', async () => {
  const onClose = vi.fn();
  renderModal(
    <Modal open label="Trap demo" onClose={onClose}>
      <Body />
    </Modal>,
  );
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('initial focus lands on the requested element', async () => {
  const screen = renderModal(
    <Modal open label="Trap demo" onClose={vi.fn()} initialFocus="[data-last]">
      <Body />
    </Modal>,
  );
  await expect.element(screen.getByText('Last')).toHaveFocus();
});

test('Tab from the last focusable wraps to the first (focus trap)', async () => {
  const screen = renderModal(
    <Modal open label="Trap demo" onClose={vi.fn()} initialFocus="[data-last]">
      <Body />
    </Modal>,
  );
  // Focus starts on Last; Tab should wrap back to First, never escaping the dialog.
  await userEvent.keyboard('{Tab}');
  await expect.element(screen.getByText('First')).toHaveFocus();
});

test('Shift+Tab from the first focusable wraps to the last (focus trap)', async () => {
  const screen = renderModal(
    <Modal open label="Trap demo" onClose={vi.fn()} initialFocus="[data-first]">
      <Body />
    </Modal>,
  );
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await expect.element(screen.getByText('Last')).toHaveFocus();
});

test('renders no dialog while closed', async () => {
  const screen = renderModal(
    <Modal open={false} label="Trap demo" onClose={vi.fn()}>
      <Body />
    </Modal>,
  );
  // Presence is owned by `open`: when false, AnimatePresence renders nothing.
  expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
});

/** A controlled harness that toggles `open` so we exercise Modal's own presence:
 *  the dialog enters when `open` flips true and its `AnimatePresence` removes it
 *  after the exit when `open` flips false (instant under the gate). */
function PresenceHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-opener onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal open={open} label="Presence demo" onClose={() => setOpen(false)}>
        <div className="p-4">
          <button data-close onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </Modal>
    </>
  );
}

test('animates presence: the panel mounts on open and is removed on close', async () => {
  const screen = renderModal(<PresenceHarness />);
  // Closed to start — Modal stays mounted but renders no dialog.
  expect(screen.container.querySelector('[role="dialog"]')).toBeNull();

  await screen.getByRole('button', { name: 'Open' }).click();
  await expect.element(screen.getByRole('dialog', { name: 'Presence demo' })).toBeInTheDocument();

  await userEvent.keyboard('{Escape}');
  // AnimatePresence runs the exit (instant under the gate) then removes the panel.
  await expect
    .element(screen.getByRole('dialog', { name: 'Presence demo' }))
    .not.toBeInTheDocument();
});

test('restores focus to the opener when closed', async () => {
  const screen = renderModal(<PresenceHarness />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await opener.click();
  // While open, focus is inside the dialog (on the Close button).
  await expect.element(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  // After close, focus returns to the element that opened the dialog.
  await expect.element(opener).toHaveFocus();
});
