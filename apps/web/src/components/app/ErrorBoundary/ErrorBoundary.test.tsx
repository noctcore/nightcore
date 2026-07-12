import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { logger } from '@/lib/logger';

import * as stories from './ErrorBoundary.stories';

const { Healthy, Caught } = composeStories(stories);

test('renders children when the tree is healthy', async () => {
  const screen = render(<Healthy />);
  await expect.element(screen.getByText('Everything is fine.')).toBeInTheDocument();
});

test('catches a render throw and shows the recoverable fallback with a reload action', async () => {
  // The boundary logs the caught error through the structured web logger (#245); spy
  // on it to both silence the underlying console output and assert it fired.
  const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    const screen = render(<Caught />);
    await expect.element(screen.getByText('Something went wrong')).toBeInTheDocument();
    await expect
      .element(screen.getByRole('button', { name: /reload/i }))
      .toBeInTheDocument();
    // The thrown message surfaces in the fallback for diagnosis.
    await expect.element(screen.getByText(/Simulated render crash/)).toBeInTheDocument();
    // The structured logger received the caught error under the UI scope, with the
    // error message carried as a field (not a bare console.error).
    expect(spy).toHaveBeenCalledWith(
      'ui.error-boundary',
      'Unhandled UI error',
      expect.objectContaining({ error: expect.stringMatching(/Simulated render crash/) }),
    );
  } finally {
    spy.mockRestore();
  }
});
