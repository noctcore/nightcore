import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Tooltip.stories';

const { Default } = composeStories(stories);

test('reveals the tip on hover and hides on leave', async () => {
  const screen = render(<Default delayMs={0} />);
  const trigger = screen.getByRole('button', { name: 'Copy' });
  await userEvent.hover(trigger.element());
  await expect.element(screen.getByRole('tooltip')).toHaveTextContent('Copy to clipboard');
  await userEvent.unhover(trigger.element());
  await expect.element(screen.getByRole('tooltip')).not.toBeInTheDocument();
});
