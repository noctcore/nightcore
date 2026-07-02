import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './DetailPanelShell.stories';

const { Default } = composeStories(stories);

test('renders the title, body sections, location, and footer action', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('An example finding title'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('What')).toBeInTheDocument();
  await expect
    .element(screen.getByText('src/app/x.ts:12-20'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /convert to task/i }))
    .toBeInTheDocument();
});

test('the close affordance invokes onClose', async () => {
  const onClose = vi.fn();
  const screen = render(<Default onClose={onClose} />);
  await screen.getByRole('button', { name: /close/i }).click();
  expect(onClose).toHaveBeenCalled();
});
