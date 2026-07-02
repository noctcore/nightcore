import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './QuestionPrompt.stories';

const { SingleQuestion, MultiSelect } = composeStories(stories);

test('renders the question, its options, and Send/Skip', async () => {
  const screen = render(<SingleQuestion />);
  await expect
    .element(screen.getByText('Which auth method should we use?'))
    .toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /OAuth/ })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /Send answer/ })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
});

test('Send is disabled until every question is answered', async () => {
  const screen = render(<SingleQuestion />);
  await expect.element(screen.getByRole('button', { name: /Send answer/ })).toBeDisabled();
  await screen.getByRole('button', { name: /OAuth/ }).click();
  await expect.element(screen.getByRole('button', { name: /Send answer/ })).toBeEnabled();
});

test('selecting an option and sending relays the chosen answer', async () => {
  const onAnswer = vi.fn();
  const screen = render(<SingleQuestion onAnswer={onAnswer} />);
  await screen.getByRole('button', { name: /OAuth/ }).click();
  await screen.getByRole('button', { name: /Send answer/ }).click();
  expect(onAnswer).toHaveBeenCalledWith('q-1', {
    behavior: 'answer',
    answers: { 'Which auth method should we use?': 'OAuth' },
  });
});

test('a free-text answer supersedes the options', async () => {
  const onAnswer = vi.fn();
  const screen = render(<SingleQuestion onAnswer={onAnswer} />);
  await screen.getByRole('textbox').fill('GraphQL subscriptions');
  await screen.getByRole('button', { name: /Send answer/ }).click();
  expect(onAnswer).toHaveBeenCalledWith('q-1', {
    behavior: 'answer',
    answers: { 'Which auth method should we use?': 'GraphQL subscriptions' },
  });
});

test('a multiSelect question joins the chosen labels with a comma', async () => {
  const onAnswer = vi.fn();
  const screen = render(<MultiSelect onAnswer={onAnswer} />);
  await screen.getByRole('button', { name: /Search/ }).click();
  await screen.getByRole('button', { name: /Export/ }).click();
  await screen.getByRole('button', { name: /Send answer/ }).click();
  expect(onAnswer).toHaveBeenCalledWith('q-2', {
    behavior: 'answer',
    answers: { 'Which features should we enable?': 'Search, Export' },
  });
});

test('Skip relays a cancel without an answer', async () => {
  const onAnswer = vi.fn();
  const screen = render(<SingleQuestion onAnswer={onAnswer} />);
  await screen.getByRole('button', { name: 'Skip' }).click();
  expect(onAnswer).toHaveBeenCalledWith('q-1', { behavior: 'cancel' });
});
