import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunOutcomeNotice.stories';

const { Failed, Aborted, Partial } = composeStories(stories);

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

test('partial: warns without claiming the run failed, and owns its own remainder', async () => {
  const screen = render(<Partial />);
  await expect
    .element(screen.getByText(/Synthesis failed: model returned no parseable plan/))
    .toBeInTheDocument();
  // The run COMPLETED, so the failed variant's auto-appended line must not apply —
  // nothing was cut short, the results below are whole apart from the dead stage.
  expect(screen.container.textContent).not.toContain('before the failure');
});
