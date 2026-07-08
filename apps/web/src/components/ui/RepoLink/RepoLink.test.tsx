import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RepoLink.stories';

const { Default } = composeStories(stories);

test('renders external link with safe attrs', async () => {
  const screen = render(<Default />);
  const link = screen.getByRole('link', { name: /open repo/i });
  await expect.element(link).toBeVisible();
  expect(link.element()).toHaveAttribute('target', '_blank');
  expect(link.element()).toHaveAttribute('rel', 'noreferrer');
});
