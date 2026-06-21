import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './ProjectCard.stories';

const { Live, Idle } = composeStories(stories);

test('shows the live badge for a running project', async () => {
  const screen = render(<Live />);
  await expect.element(screen.getByText('live')).toBeInTheDocument();
});

test('calls onOpen with the project id from the identity affordance', async () => {
  const onOpen = vi.fn();
  const screen = render(<Idle onOpen={onOpen} />);
  await screen.getByText('automaker (legacy)').click();
  expect(onOpen).toHaveBeenCalledWith('automaker');
});
