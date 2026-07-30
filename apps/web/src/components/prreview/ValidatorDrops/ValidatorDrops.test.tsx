import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ValidatorDrops.stories';

const { OneDrop, ManyDrops, NoDrops } = composeStories(stories);

test('renders nothing when the validator dropped nothing', () => {
  const screen = render(<NoDrops />);
  expect(screen.container.textContent).toBe('');
});

test('summarizes the drop count and stays COLLAPSED by default', async () => {
  const screen = render(<OneDrop />);
  const toggle = screen.getByRole('button', {
    name: 'Dropped by the validator (1)',
    exact: true,
  });
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
  // Collapsed: the dropped finding's title is not rendered yet.
  expect(screen.container.textContent).not.toContain(
    'Unvalidated path joins user input',
  );
});

test('expanding lists every dropped finding so none disappears silently', async () => {
  const screen = render(<ManyDrops />);
  const toggle = screen.getByRole('button', {
    name: 'Dropped by the validator (3)',
    exact: true,
  });
  await toggle.click();
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const title of [
    'Unvalidated path joins user input',
    'No regression test for the new branch',
    'Off-by-one in the slice bound',
  ]) {
    expect(screen.container.textContent).toContain(title);
  }
  // A line-less drop still shows its file (no bogus ":null" anchor).
  expect(screen.container.textContent).toContain('src/lib.rs');
  expect(screen.container.textContent).not.toContain('src/lib.rs:');
});

test('offers no lifecycle action on a dropped finding (read-only audit list)', async () => {
  const screen = render(<ManyDrops />);
  await screen
    .getByRole('button', { name: 'Dropped by the validator (3)', exact: true })
    .click();
  // The disclosure toggle is the ONLY control: nothing here is selectable,
  // convertible, or postable.
  expect(screen.container.querySelectorAll('button')).toHaveLength(1);
  expect(screen.container.querySelectorAll('input')).toHaveLength(0);
});
