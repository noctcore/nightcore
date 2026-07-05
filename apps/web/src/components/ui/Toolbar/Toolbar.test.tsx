import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { Toolbar } from './Toolbar';
import * as stories from './Toolbar.stories';

const { FixedControls, WithFlexibleChild } = composeStories(stories);

test('renders its control children as a labelled group', async () => {
  const screen = render(<FixedControls />);
  await expect.element(screen.getByRole('button', { name: 'New task' })).toBeVisible();
  await expect
    .element(screen.getByRole('group', { name: 'Board actions' }))
    .toBeInTheDocument();
});

test('pins every direct child shrink-0 and wraps instead of squishing', async () => {
  const screen = render(<WithFlexibleChild />);
  const group = screen.getByRole('group', { name: 'Search and filter' }).element();
  // The anti-squish convention: wrapping row + every direct child pinned shrink-0.
  expect(group.className).toContain('flex-wrap');
  expect(group.className).toContain('[&>*]:shrink-0');
});

test('omits the group role when no label is given (plain container)', async () => {
  const screen = render(
    <Toolbar>
      <button type="button">Only child</button>
    </Toolbar>,
  );
  await expect.element(screen.getByRole('button', { name: 'Only child' })).toBeVisible();
  expect(screen.container.querySelector('[role="group"]')).toBeNull();
});
