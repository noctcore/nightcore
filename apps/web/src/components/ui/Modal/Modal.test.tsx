import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
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

test('Escape routes to onClose', async () => {
  const onClose = vi.fn();
  render(
    <Modal label="Trap demo" onClose={onClose}>
      <Body />
    </Modal>,
  );
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('initial focus lands on the requested element', async () => {
  const screen = render(
    <Modal label="Trap demo" onClose={vi.fn()} initialFocus="[data-last]">
      <Body />
    </Modal>,
  );
  await expect.element(screen.getByText('Last')).toHaveFocus();
});

test('Tab from the last focusable wraps to the first (focus trap)', async () => {
  const screen = render(
    <Modal label="Trap demo" onClose={vi.fn()} initialFocus="[data-last]">
      <Body />
    </Modal>,
  );
  // Focus starts on Last; Tab should wrap back to First, never escaping the dialog.
  await userEvent.keyboard('{Tab}');
  await expect.element(screen.getByText('First')).toHaveFocus();
});

test('Shift+Tab from the first focusable wraps to the last (focus trap)', async () => {
  const screen = render(
    <Modal label="Trap demo" onClose={vi.fn()} initialFocus="[data-first]">
      <Body />
    </Modal>,
  );
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  await expect.element(screen.getByText('Last')).toHaveFocus();
});

/** A harness that mounts/unmounts the Modal so we can assert focus returns to the
 *  opener button — the restore-to-opener behavior the per-dialog copies lacked. */
function RestoreHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-opener onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Modal label="Restore demo" onClose={() => setOpen(false)}>
          <div className="p-4">
            <button data-close onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

test('restores focus to the opener when closed', async () => {
  const screen = render(<RestoreHarness />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await opener.click();
  // While open, focus is inside the dialog (on the Close button).
  await expect.element(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  // After close, focus returns to the element that opened the dialog.
  await expect.element(opener).toHaveFocus();
});
