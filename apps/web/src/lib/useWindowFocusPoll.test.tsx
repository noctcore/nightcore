import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { useWindowFocusPoll } from './useWindowFocusPoll';

function Harness({ onFocus, enabled = true }: { onFocus: () => void; enabled?: boolean }) {
  useWindowFocusPoll(onFocus, enabled);
  return null;
}

/** Temporarily force `document.visibilityState` so the visibilitychange path is testable
 *  regardless of the real tab state; returns a restore function. */
function stubVisibility(value: DocumentVisibilityState): () => void {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  return () => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
  };
}

afterEach(() => vi.useRealTimers());

test('a window focus triggers the callback after the debounce', () => {
  const onFocus = vi.fn();
  render(<Harness onFocus={onFocus} />);
  vi.useFakeTimers();

  window.dispatchEvent(new Event('focus'));
  expect(onFocus).not.toHaveBeenCalled();

  vi.advanceTimersByTime(999);
  expect(onFocus).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(onFocus).toHaveBeenCalledTimes(1);
});

test('a burst of focus events collapses to a single poll', () => {
  const onFocus = vi.fn();
  render(<Harness onFocus={onFocus} />);
  vi.useFakeTimers();

  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(1000);
  expect(onFocus).toHaveBeenCalledTimes(1);
});

test('visibilitychange fires only when the document becomes visible', () => {
  const onFocus = vi.fn();
  render(<Harness onFocus={onFocus} />);

  const restoreHidden = stubVisibility('hidden');
  vi.useFakeTimers();
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(1000);
  expect(onFocus).not.toHaveBeenCalled();
  vi.useRealTimers();
  restoreHidden();

  const restoreVisible = stubVisibility('visible');
  vi.useFakeTimers();
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(1000);
  expect(onFocus).toHaveBeenCalledTimes(1);
  restoreVisible();
});

test('is inert when disabled and cleans up its listeners on unmount', () => {
  const onFocus = vi.fn();
  const disabled = render(<Harness onFocus={onFocus} enabled={false} />);
  vi.useFakeTimers();
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(1000);
  expect(onFocus).not.toHaveBeenCalled();
  disabled.unmount();

  const enabled = render(<Harness onFocus={onFocus} />);
  enabled.unmount();
  // After unmount the listener is gone — a later focus must not fire the callback.
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(1000);
  expect(onFocus).not.toHaveBeenCalled();
});
