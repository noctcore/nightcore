import { userEvent } from '@vitest/browser/context';
import { beforeEach, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { useResizablePanelWidth } from './prreview-resize.hooks';

const KEY = 'nc:test:list-width';

/** A tiny harness rendering the divider + the live width so tests can drive the
 *  keyboard/double-click paths and read the resulting width. */
function Harness() {
  const panel = useResizablePanelWidth({ storageKey: KEY, defaultWidth: 380, min: 280, max: 560, step: 24 });
  return (
    <div>
      <span data-testid="width">{panel.width}</span>
      {/* Give the divider real dimensions so pointer actions (dblclick) are
          actionable in the browser runner. */}
      <div
        {...panel.separatorProps}
        data-testid="divider"
        style={{ width: 12, height: 48, background: '#888' }}
      />
    </div>
  );
}

beforeEach(() => {
  window.localStorage.removeItem(KEY);
});

test('the divider exposes the width as a role=separator with aria-valuenow', async () => {
  const screen = render(<Harness />);
  const divider = screen.getByRole('separator', { name: /resize the pull-request list/i });
  await expect.element(divider).toHaveAttribute('aria-valuenow', '380');
  await expect.element(divider).toHaveAttribute('aria-orientation', 'vertical');
});

test('ArrowRight/ArrowLeft nudge the width by the step and persist it', async () => {
  const screen = render(<Harness />);
  const divider = screen.getByTestId('divider');
  (divider.element() as HTMLElement).focus();
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(screen.getByTestId('width')).toHaveTextContent('404');
  expect(window.localStorage.getItem(KEY)).toBe('404');
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
  await expect.element(screen.getByTestId('width')).toHaveTextContent('356');
});

test('End/Home jump to the clamp bounds', async () => {
  const screen = render(<Harness />);
  (screen.getByTestId('divider').element() as HTMLElement).focus();
  await userEvent.keyboard('{End}');
  await expect.element(screen.getByTestId('width')).toHaveTextContent('560');
  await userEvent.keyboard('{Home}');
  await expect.element(screen.getByTestId('width')).toHaveTextContent('280');
});

test('double-click resets to the default width', async () => {
  const screen = render(<Harness />);
  (screen.getByTestId('divider').element() as HTMLElement).focus();
  await userEvent.keyboard('{End}');
  await expect.element(screen.getByTestId('width')).toHaveTextContent('560');
  await screen.getByTestId('divider').dblClick();
  await expect.element(screen.getByTestId('width')).toHaveTextContent('380');
});

test('a persisted width is restored (and clamped) on mount', async () => {
  window.localStorage.setItem(KEY, '999'); // beyond max → clamps to 560
  const screen = render(<Harness />);
  await expect.element(screen.getByTestId('width')).toHaveTextContent('560');
});
