import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './CategoryTabs.stories';

const { Default, BugsActive } = composeStories(stories);

test('renders a tab per descriptor with the open count badge', async () => {
  const screen = render(<Default />);
  const tabs = screen.container.querySelectorAll('[role="tab"]');
  expect(tabs).toHaveLength(5);
  // The "All" tab is running → aria-busy="true" on the tab, pulse dot is aria-hidden.
  const allTab = screen.container.querySelector('[role="tab"][aria-busy="true"]');
  expect(allTab).not.toBeNull();
  expect(screen.container.querySelector('[aria-hidden="true"].animate-pulse')).not.toBeNull();
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
