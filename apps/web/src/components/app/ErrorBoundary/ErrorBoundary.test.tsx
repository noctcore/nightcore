import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ErrorBoundary.stories';

const { Healthy, Caught } = composeStories(stories);

test('renders children when the tree is healthy', async () => {
  const screen = render(<Healthy />);
  await expect.element(screen.getByText('Everything is fine.')).toBeInTheDocument();
});

test('catches a render throw and shows the recoverable fallback with a reload action', async () => {
  // The boundary logs the caught error; silence it so the suite stays clean.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const screen = render(<Caught />);
    await expect.element(screen.getByText('Something went wrong')).toBeInTheDocument();
    await expect
      .element(screen.getByRole('button', { name: /reload/i }))
      .toBeInTheDocument();
    // The thrown message surfaces in the fallback for diagnosis.
    await expect.element(screen.getByText(/Simulated render crash/)).toBeInTheDocument();
  } finally {
    spy.mockRestore();
  }
});
