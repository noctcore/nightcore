import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { CouncilStartPanel } from './CouncilStartPanel';
import * as stories from './CouncilStartPanel.stories';

const { Default, NoProject } = composeStories(stories);

test('Start is disabled until the objective has content, then fires onStart', async () => {
  const onStart = vi.fn();
  const screen = render(<CouncilStartPanel onStart={onStart} />);

  const button = screen.getByRole('button', { name: /Convene council/ });
  await expect.element(button).toBeDisabled();

  await screen.getByLabelText('Objective').fill('Compare two migration strategies.');
  await expect.element(button).toBeEnabled();
  await button.click();
  expect(onStart).toHaveBeenCalledWith('Compare two migration strategies.');
});

test('renders the research preset and its governed-reasoning framing', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Research')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Convene a council' }))
    .toBeInTheDocument();
});

test('the disabled (no-project) state blocks Start and explains why', async () => {
  const screen = render(<NoProject />);
  await expect
    .element(screen.getByRole('button', { name: /Convene council/ }))
    .toBeDisabled();
  await expect
    .element(screen.getByText('Open a project to convene a council.'))
    .toBeInTheDocument();
});
