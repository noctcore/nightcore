import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './UsageLimitBanner.stories';

const { Default, Analysis, HiddenWhenHealthy, HiddenWhileRunning } =
  composeStories(stories);

test('surfaces the usage-limit signature on a $0 / zero-token completed run', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/spent \$0\.00 and used no tokens/))
    .toBeInTheDocument();
  await expect.element(screen.getByRole('alert')).toBeInTheDocument();
});

test('uses the run noun in the copy', async () => {
  const screen = render(<Analysis />);
  expect(screen.container.textContent).toContain('analysis');
});

test('renders nothing when the run actually consumed tokens', () => {
  const screen = render(<HiddenWhenHealthy />);
  expect(screen.container.textContent).toBe('');
});

test('renders nothing while the run is still running', () => {
  const screen = render(<HiddenWhileRunning />);
  expect(screen.container.textContent).toBe('');
});
