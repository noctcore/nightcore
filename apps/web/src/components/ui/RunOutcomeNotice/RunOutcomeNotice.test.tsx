import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunOutcomeNotice.stories';

const { Failed, Aborted } = composeStories(stories);

test('failed: shows the error message and the reassurance line', async () => {
  const screen = render(<Failed />);
  await expect
    .element(screen.getByText(/Analysis failed: provider returned 503\./))
    .toBeInTheDocument();
  await expect
    .element(
      screen.getByText(/Any findings that streamed before the failure are shown below\./),
    )
    .toBeInTheDocument();
});

test('aborted: shows the neutral message without the reassurance line', async () => {
  const screen = render(<Aborted />);
  await expect.element(screen.getByText(/Analysis cancelled\./)).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('before the failure');
});
