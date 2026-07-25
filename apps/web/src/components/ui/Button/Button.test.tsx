import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import * as stories from './Button.stories';

const { Primary, FiresOnClick, Busy, AriaDisabled } = composeStories(stories);

test('renders button label', async () => {
  const screen = render(
    <MotionProvider>
      <Primary />
    </MotionProvider>,
  );
  await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('click invokes onClick', async () => {
  const onClick = vi.fn();
  const screen = render(
    <MotionProvider>
      <FiresOnClick onClick={onClick} />
    </MotionProvider>,
  );
  await screen.getByRole('button', { name: 'Save' }).click();
  expect(onClick).toHaveBeenCalled();
});

test('busy disables the button and marks it aria-busy', async () => {
  const screen = render(
    <MotionProvider>
      <Busy />
    </MotionProvider>,
  );
  const button = screen.getByRole('button', { name: 'Saving…' });
  await expect.element(button).toBeDisabled();
  await expect.element(button).toHaveAttribute('aria-busy', 'true');
});

test('an aria-disabled button stays focusable but drops its hover affordance', async () => {
  const screen = render(
    <MotionProvider>
      <AriaDisabled />
    </MotionProvider>,
  );
  const button = screen.getByRole('button', { name: 'Save' });
  // Not NATIVELY disabled (the DOM `disabled` property is false, so it stays
  // focusable/reachable) — only aria-disabled. Playwright's toBeDisabled treats
  // aria-disabled as disabled, so assert the native property directly.
  await expect.element(button).toHaveAttribute('aria-disabled', 'true');
  expect((button.element() as HTMLButtonElement).disabled).toBe(false);
  // The variant's hover class is gated off so it never hover-tints.
  expect(button.element().className).not.toContain('hover:');
});
