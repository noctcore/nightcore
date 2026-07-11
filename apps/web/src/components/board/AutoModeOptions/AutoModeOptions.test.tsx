import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './AutoModeOptions.stories';

const { Collapsed, Enabled, MeterDisabled } = composeStories(stories);

test('starts collapsed — no options panel until the gear is clicked', async () => {
  const screen = render(<Collapsed />);
  expect(screen.container.querySelector('[role="group"]')).toBeNull();
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .toBeInTheDocument();
});

test('toggling the switch reports the next value', async () => {
  const onAutoCommitChange = vi.fn();
  const screen = render(<Collapsed onAutoCommitChange={onAutoCommitChange} />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await screen.getByRole('switch', { name: /auto-commit on verified/i }).click();
  expect(onAutoCommitChange).toHaveBeenCalledWith(true);
});

test('reflects the enabled option as aria-checked', async () => {
  const screen = render(<Enabled />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('the usage-throttle slider is a 50–100 range at its persisted value', async () => {
  const screen = render(<Collapsed autoPauseUsageThreshold={90} />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  const slider = screen.getByRole('slider', { name: /pause auto mode at usage/i });
  await expect.element(slider).toHaveAttribute('min', '50');
  await expect.element(slider).toHaveAttribute('max', '100');
  await expect.element(slider).toHaveValue('90');
  await expect.element(slider).toBeEnabled();
});

test('disables the slider and hints when the usage meter is off', async () => {
  const screen = render(<MeterDisabled />);
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('slider', { name: /pause auto mode at usage/i }))
    .toBeDisabled();
  await expect
    .element(screen.getByText(/enable the usage meter to use this/i))
    .toBeInTheDocument();
});

test('closes when focus leaves the panel (Tab-out, a11y)', async () => {
  // A keyboard user tabbing past the last control must not be stranded on an
  // element behind the still-open popover — focus-out closes it.
  const screen = render(
    <div>
      <Collapsed />
      <button type="button" data-testid="after">
        after
      </button>
    </div>,
  );
  await screen.getByRole('button', { name: /auto mode options/i }).click();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .toBeInTheDocument();
  // Move focus to a control outside the popover — simulates Tab past the panel.
  (screen.getByTestId('after').element() as HTMLElement).focus();
  await expect
    .element(screen.getByRole('switch', { name: /auto-commit on verified/i }))
    .not.toBeInTheDocument();
});
