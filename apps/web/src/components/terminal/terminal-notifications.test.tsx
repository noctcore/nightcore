import { expect, test } from 'vitest';

import { shouldNotifyCompletion } from './terminal-notifications';

test('shouldNotifyCompletion respects the setting and only fires when the user cannot see the terminal', () => {
  // Setting off → never notify.
  expect(shouldNotifyCompletion({ enabled: false, visible: false, windowFocused: false })).toBe(
    false,
  );

  // Visible AND the window focused → the user is looking right at it, don't interrupt.
  expect(shouldNotifyCompletion({ enabled: true, visible: true, windowFocused: true })).toBe(false);

  // Off-screen pane (even if the window is focused) → notify.
  expect(shouldNotifyCompletion({ enabled: true, visible: false, windowFocused: true })).toBe(true);

  // Visible pane but the window is unfocused/hidden → notify.
  expect(shouldNotifyCompletion({ enabled: true, visible: true, windowFocused: false })).toBe(true);

  // Off-screen and unfocused → notify.
  expect(shouldNotifyCompletion({ enabled: true, visible: false, windowFocused: false })).toBe(
    true,
  );
});
