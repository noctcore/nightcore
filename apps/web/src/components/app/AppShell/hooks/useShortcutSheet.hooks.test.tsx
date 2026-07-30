import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { useShortcutSheet } from './useShortcutSheet.hooks';

function Harness({
  enabled = true,
  onState,
}: {
  enabled?: boolean;
  onState: (open: boolean) => void;
}) {
  const sheet = useShortcutSheet(enabled);
  onState(sheet.open);
  return (
    <button type="button" onClick={sheet.show}>
      open sheet
    </button>
  );
}

function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

/** The last `open` value the hook rendered with. */
function tracker() {
  const seen: boolean[] = [];
  return { seen, record: (open: boolean) => seen.push(open) };
}

test('`?` opens the sheet, and `?` again closes it', async () => {
  const t = tracker();
  render(<Harness onState={t.record} />);
  expect(t.seen.at(-1)).toBe(false);

  press('?', { shiftKey: true });
  await vi.waitFor(() => expect(t.seen.at(-1)).toBe(true));

  press('?', { shiftKey: true });
  await vi.waitFor(() => expect(t.seen.at(-1)).toBe(false));
});

test('never fires while the user is typing', async () => {
  const t = tracker();
  render(<Harness onState={t.record} />);
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  // `?` is a literal character — stealing it mid-sentence is the failure that matters.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
  await Promise.resolve();
  expect(t.seen.at(-1)).toBe(false);
  input.remove();
});

test('lets ⌘/Ctrl/Alt chords through untouched', async () => {
  const t = tracker();
  render(<Harness onState={t.record} />);
  press('?', { metaKey: true });
  press('?', { ctrlKey: true });
  press('?', { altKey: true });
  await Promise.resolve();
  expect(t.seen.at(-1)).toBe(false);
});

test('does not open over another dialog', async () => {
  const t = tracker();
  render(<Harness onState={t.record} />);
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  document.body.appendChild(dialog);
  press('?', { shiftKey: true });
  await Promise.resolve();
  expect(t.seen.at(-1)).toBe(false);
  dialog.remove();
});

test('the layer is inert when disabled (splash / onboarding own the window)', async () => {
  const t = tracker();
  render(<Harness enabled={false} onState={t.record} />);
  press('?', { shiftKey: true });
  await Promise.resolve();
  expect(t.seen.at(-1)).toBe(false);
});
