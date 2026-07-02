import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { interactionCount } from './InteractionDock.hooks';
import * as stories from './InteractionDock.stories';

const { Empty, QuestionOnly, Both } = composeStories(stories);

test('renders nothing when there are no parked interactions', () => {
  const screen = render(<Empty />);
  expect(screen.container.querySelector('[aria-label="Needs your input"]')).toBeNull();
});

test('surfaces both a question and a permission with a count badge', async () => {
  const screen = render(<Both />);
  await expect.element(screen.getByText('Needs your input')).toBeInTheDocument();
  await expect.element(screen.getByText('Which approach should we take?')).toBeInTheDocument();
  await expect.element(screen.getByText('Bash')).toBeInTheDocument();
  // Two parked interactions → the count badge shows.
  await expect.element(screen.getByText('2')).toBeInTheDocument();
});

test('relays a question answer tagged with the dock task id', async () => {
  const onAnswerQuestion = vi.fn();
  const screen = render(<QuestionOnly onAnswerQuestion={onAnswerQuestion} />);
  await screen.getByRole('button', { name: /Incremental/ }).click();
  await screen.getByRole('button', { name: /Send answer/ }).click();
  expect(onAnswerQuestion).toHaveBeenCalledWith('t-running', 'q-1', {
    behavior: 'answer',
    answers: { 'Which approach should we take?': 'Incremental' },
  });
});

test('interactionCount sums both prompt families', () => {
  expect(interactionCount([], [])).toBe(0);
  expect(
    interactionCount(
      [{ taskId: 't', requestId: 'r', toolName: 'Bash', input: {} }],
      [],
    ),
  ).toBe(1);
});
