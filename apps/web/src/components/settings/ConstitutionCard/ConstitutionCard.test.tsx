import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ConstitutionCard } from './ConstitutionCard';
import * as stories from './ConstitutionCard.stories';

const { Active, NoProject } = composeStories(stories);

test('renders the Constitution header', async () => {
  const screen = render(<Active />);
  await expect
    .element(screen.getByText('Project Constitution'))
    .toBeInTheDocument();
});

test('shows an empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect
    .element(screen.getByText(/activate a project to author its constitution/i))
    .toBeInTheDocument();
});

test('toggling injection emits the flipped value', async () => {
  const onToggleEnabled = vi.fn();
  const screen = render(
    <ConstitutionCard
      enabled
      onToggleEnabled={onToggleEnabled}
      projectActive
    />,
  );
  await screen
    .getByRole('switch', { name: /inject the context pack into runs/i })
    .click();
  expect(onToggleEnabled).toHaveBeenCalledWith(false);
});

test('Edit mode reveals the markdown textarea', async () => {
  const screen = render(
    <ConstitutionCard enabled onToggleEnabled={vi.fn()} projectActive />,
  );
  // Switch from the preview to the raw editor.
  await screen.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect
    .element(screen.getByLabelText('Context pack markdown'))
    .toBeInTheDocument();
});
