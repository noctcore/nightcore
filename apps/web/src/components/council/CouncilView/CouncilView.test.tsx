import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './CouncilView.stories';

const { Idle, NoProject } = composeStories(stories);

test('an active project shows the Council header and the convene start panel', async () => {
  const screen = render(<Idle />);
  await expect
    .element(screen.getByRole('heading', { name: 'Council', level: 1 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Convene a council' }))
    .toBeInTheDocument();
});

test('no active project shows the no-project empty state', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
