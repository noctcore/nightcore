import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TaskAttachments.stories';

const { EmptyEditable, Editable, ReadOnly } = composeStories(stories);

test('a pre-run task shows the add dropzone', async () => {
  const screen = render(<EmptyEditable />);
  await expect
    .element(screen.getByRole('button', { name: /add images/i }))
    .toBeInTheDocument();
});

test('a pre-run task with images renders a removable item per attachment', async () => {
  const screen = render(<Editable />);
  await expect
    .element(screen.getByRole('button', { name: /remove login-screen\.png/i }))
    .toBeInTheDocument();
});

test('a run task is read-only — no add zone, no remove buttons', async () => {
  const screen = render(<ReadOnly />);
  expect(screen.getByRole('button', { name: /add images/i }).query()).toBeNull();
  expect(screen.getByRole('button', { name: /remove/i }).query()).toBeNull();
  // The thumbnail grid still renders (placeholder tiles outside Tauri, where the
  // bytes can't be read).
  await expect
    .element(screen.getByRole('list', { name: /attached images/i }))
    .toBeInTheDocument();
});
