import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './EditProjectDialog.stories';

const { Default } = composeStories(stories);

test('shows the project name field', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('nightcore');
});
