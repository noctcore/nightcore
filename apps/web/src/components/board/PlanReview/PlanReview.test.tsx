import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PlanReview.stories';

const { Parked } = composeStories(stories);

test('renders the proposed plan and the review controls', async () => {
  const screen = render(<Parked />);
  await expect.element(screen.getByText('Proposed plan')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Refine' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
});

test('relays the typed feedback to onRefine (same-session refinement prompt)', async () => {
  const onRefine = vi.fn();
  const screen = render(<Parked onRefine={onRefine} />);
  await screen.getByLabelText('Refine feedback').fill('use a worker pool');
  await screen.getByRole('button', { name: 'Refine' }).click();
  expect(onRefine).toHaveBeenCalledWith('t-plan', 'use a worker pool');
});

test('fires onReject when Reject is clicked', async () => {
  const onReject = vi.fn();
  const screen = render(<Parked onReject={onReject} />);
  await screen.getByRole('button', { name: 'Reject' }).click();
  expect(onReject).toHaveBeenCalledWith('t-plan');
});
