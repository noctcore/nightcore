import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './UpdateChecker.stories';

vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    isTauri: () => false,
    checkForAppUpdate: vi.fn(),
    installCachedAppUpdate: vi.fn(),
    clearCachedAppUpdate: vi.fn(),
  };
});

const { BrowserPreview } = composeStories(stories);

test('shows the browser-preview fallback outside Tauri', async () => {
  const screen = render(<BrowserPreview />);
  await expect
    .element(screen.getByText(/updates are available in the desktop app/i))
    .toBeInTheDocument();
});