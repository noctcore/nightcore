import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './IssueSyncNotice.stories';

const { CommentsOnly, Healthy } = composeStories(stories);

test('surfaces the degradation reason when issueSyncError is set', async () => {
  const screen = render(<CommentsOnly />);
  await expect.element(screen.getByText(/comments-only/i)).toBeInTheDocument();
});

test('renders nothing when sync is healthy (no error)', async () => {
  const screen = render(<Healthy />);
  // No banner text and no dismiss button — the component returns null.
  expect(screen.getByText(/comments-only/i).query()).toBeNull();
  expect(screen.getByRole('button', { name: /dismiss the issue-sync notice/i }).query()).toBeNull();
});

test('dismisses the notice on the close button', async () => {
  const screen = render(<CommentsOnly />);
  const dismiss = screen.getByRole('button', { name: /dismiss the issue-sync notice/i });
  await expect.element(dismiss).toBeInTheDocument();

  await dismiss.click();
  // Dismissal is keyed by the message, so the same reason stays hidden.
  expect(screen.getByText(/comments-only/i).query()).toBeNull();
});
