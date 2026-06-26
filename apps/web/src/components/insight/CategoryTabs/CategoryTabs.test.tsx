import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './CategoryTabs.stories';

const { Default, BugsActive } = composeStories(stories);

test('renders a tab per descriptor with the open count badge', async () => {
  const screen = render(<Default />);
  const tabs = screen.container.querySelectorAll('[role="tab"]');
  expect(tabs).toHaveLength(5);
  // The "All" tab is running → shows an analyzing pulse, not a count badge.
  expect(screen.container.querySelector('[aria-label="analyzing"]')).not.toBeNull();
});

test('marks the active tab selected', async () => {
  const screen = render(<BugsActive />);
  const bugs = screen.getByRole('tab', { name: /bugs/i });
  await expect.element(bugs).toHaveAttribute('aria-selected', 'true');
});

test('fires onSelect with the tab key when clicked', async () => {
  const onSelect = vi.fn();
  const screen = render(<Default onSelect={onSelect} />);
  await screen.getByRole('tab', { name: /bugs/i }).click();
  expect(onSelect).toHaveBeenCalledWith('bugs');
});
