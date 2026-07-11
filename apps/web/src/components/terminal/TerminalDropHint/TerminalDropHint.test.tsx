import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { dropHintLabel } from '../terminal-shared';
import { TerminalDropHint } from './TerminalDropHint';

test('renders the drop-hint copy for the pane under a dragged file', () => {
  const screen = render(<TerminalDropHint />);
  expect(screen.getByText(dropHintLabel()).element().textContent).toBe(dropHintLabel());
});

test('the overlay is pointer-events-none so it never intercepts the drop hit-test', () => {
  // `elementFromPoint` skips pointer-events:none elements, so the overlay can cover the
  // pane without stealing the `over`/`drop` position hit-test that resolves the target.
  const screen = render(<TerminalDropHint />);
  expect(screen.getByRole('status').element().className).toContain('pointer-events-none');
});
