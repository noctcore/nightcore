import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { HumanInputBar } from './HumanInputBar';
import * as stories from './HumanInputBar.stories';

const { DispatchFails, NoLiveCouncil, NoSeatsYet } = composeStories(stories);

const SEATS = ['proposer-opus', 'proposer-sonnet', 'critic-opus'];

test('broadcast relays the message to every seat through the conductor', async () => {
  const onSend = vi.fn(async () => {});
  const screen = render(<HumanInputBar seatIds={SEATS} onSend={onSend} live />);

  const broadcast = screen.getByRole('button', { name: 'Broadcast to all' });
  // Nothing to relay until something is typed.
  await expect.element(broadcast).toBeDisabled();

  await screen.getByLabelText('Your message').fill('Weigh the rollback rehearsal.');
  await expect.element(broadcast).toBeEnabled();
  await broadcast.click();

  // No seat id — the Conductor fans out to every live seat.
  expect(onSend).toHaveBeenCalledWith(
    'broadcast',
    'Weigh the rollback rehearsal.',
    undefined,
  );
});

test('DM-one relays to the chosen seat only', async () => {
  const onSend = vi.fn(async () => {});
  const screen = render(<HumanInputBar seatIds={SEATS} onSend={onSend} live />);

  await screen.getByRole('radio', { name: 'One seat' }).click();
  await screen.getByLabelText('Recipient').selectOptions('critic-opus');
  await screen.getByLabelText('Your message').fill('Defend your objection.');
  await screen.getByRole('button', { name: 'Send to seat' }).click();

  expect(onSend).toHaveBeenCalledWith(
    'direct',
    'Defend your objection.',
    'critic-opus',
  );
});

test('steer relays the message AND asks the conductor to advance the stage', async () => {
  const onSend = vi.fn(async () => {});
  const screen = render(<HumanInputBar seatIds={SEATS} onSend={onSend} live />);

  await screen.getByLabelText('Your message').fill('Enough — settle on the flag plan.');
  await screen.getByRole('button', { name: /Steer/ }).click();

  expect(onSend).toHaveBeenCalledWith(
    'steer',
    'Enough — settle on the flag plan.',
    undefined,
  );
});

test('a dispatch failure surfaces inline and KEEPS the draft so it can be retried', async () => {
  const screen = render(<DispatchFails />);

  await screen.getByLabelText('Your message').fill('Reconsider the cutover window.');
  await screen.getByRole('button', { name: 'Broadcast to all' }).click();

  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('The sidecar is not running.');
  // The draft survives a failure (the message was never relayed), and the control returns.
  await expect
    .element(screen.getByLabelText('Your message'))
    .toHaveValue('Reconsider the cutover window.');
  await expect
    .element(screen.getByRole('button', { name: 'Broadcast to all' }))
    .toBeEnabled();
});

test('with no live council the affordance stays visible but inert', async () => {
  const screen = render(<NoLiveCouncil />);

  await expect
    .element(screen.getByRole('button', { name: 'Broadcast to all' }))
    .toBeDisabled();
  // No composer at all — there is no run to address.
  await expect.element(screen.getByLabelText('Your message')).not.toBeInTheDocument();
});

test('a DM cannot be sent before any seat has spoken', async () => {
  const screen = render(<NoSeatsYet />);

  await screen.getByRole('radio', { name: 'One seat' }).click();
  await screen.getByLabelText('Your message').fill('Anyone there?');
  await expect
    .element(screen.getByRole('button', { name: 'Send to seat' }))
    .toBeDisabled();
});
