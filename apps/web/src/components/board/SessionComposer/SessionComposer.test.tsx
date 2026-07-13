import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SessionComposer.stories';

const { Single, Broadcast } = composeStories(stories);

test('Send is disabled until the draft has non-whitespace content', async () => {
  const screen = render(<Single />);
  const send = screen.getByRole('button', { name: /Send/ });
  await expect.element(send).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Message the agent').element(), 'hello agent');
  await expect.element(send).toBeEnabled();
});

test('sends the message to the origin session and clears the draft', async () => {
  const onSendInput = vi.fn();
  const screen = render(<Single onSendInput={onSendInput} />);

  const input = screen.getByLabelText('Message the agent');
  await userEvent.type(input.element(), 'run the tests again');
  await screen.getByRole('button', { name: /Send/ }).click();

  expect(onSendInput).toHaveBeenCalledTimes(1);
  expect(onSendInput).toHaveBeenCalledWith('t-running', 'run the tests again');
  // The draft is cleared after a send.
  await expect.element(input).toHaveValue('');
});

test('no broadcast toggle with a single live session', async () => {
  const screen = render(<Single />);
  await expect
    .element(screen.getByRole('button', { name: /Broadcast/ }))
    .not.toBeInTheDocument();
});

test('armed broadcast fans one message across every live session', async () => {
  const onSendInput = vi.fn();
  const screen = render(<Broadcast onSendInput={onSendInput} />);

  await userEvent.type(screen.getByLabelText('Message the agent').element(), 'stop and summarize');
  // Arm broadcast, then send.
  await screen.getByRole('button', { name: 'Broadcast off' }).click();
  await screen.getByRole('button', { name: /Send to 3/ }).click();

  expect(onSendInput).toHaveBeenCalledTimes(3);
  const targets = onSendInput.mock.calls.map((c) => c[0]);
  expect(new Set(targets)).toEqual(new Set(['t-running', 't-other', 't-third']));
  for (const call of onSendInput.mock.calls) {
    expect(call[1]).toBe('stop and summarize');
  }
});

test('disarmed multi-session composer sends to the origin alone', async () => {
  const onSendInput = vi.fn();
  const screen = render(<Broadcast onSendInput={onSendInput} />);

  await userEvent.type(screen.getByLabelText('Message the agent').element(), 'just you');
  await screen.getByRole('button', { name: /Send/ }).click();

  expect(onSendInput).toHaveBeenCalledTimes(1);
  expect(onSendInput).toHaveBeenCalledWith('t-running', 'just you');
});
