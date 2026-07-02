import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './CategoryTabsShell.stories';

const { Default, BugsActive } = composeStories(stories);

test('renders a tab per descriptor', async () => {
  const screen = render(<Default />);
  expect(screen.container.querySelectorAll('[role="tab"]')).toHaveLength(4);
});

test('marks the active tab selected', async () => {
  const screen = render(<BugsActive />);
  await expect
    .element(screen.getByRole('tab', { name: /bugs/i }))
    .toHaveAttribute('aria-selected', 'true');
});

test('fires onSelect with the tab key when clicked', async () => {
  const onSelect = vi.fn();
  const screen = render(<Default onSelect={onSelect} />);
  await screen.getByRole('tab', { name: /bugs/i }).click();
  expect(onSelect).toHaveBeenCalledWith('bugs');
});

test('shows the error indicator with its accessible label for an errored tab', async () => {
  const screen = render(<Default />);
  expect(
    screen.container.querySelector('[aria-label="analysis failed"]'),
  ).not.toBeNull();
});
