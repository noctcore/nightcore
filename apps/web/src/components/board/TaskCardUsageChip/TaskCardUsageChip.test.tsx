import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TaskCardUsageChip.stories';

const { Hot, ModelScoped, Cool } = composeStories(stories);

test('renders the "usage high" chip when the window is hot', async () => {
  const screen = render(<Hot />);
  await expect.element(screen.getByText(/usage high/i)).toBeInTheDocument();
});

test('names the hot window + percent in the tooltip', async () => {
  const screen = render(<ModelScoped />);
  const chip = screen.container.querySelector('[title]');
  expect(chip?.getAttribute('title')).toMatch(/Claude Opus weekly at 96% — this run counts/i);
});

test('renders nothing when usage is cool / the meter is off', async () => {
  const screen = render(<Cool />);
  expect(screen.container.textContent).not.toMatch(/usage high/i);
});
