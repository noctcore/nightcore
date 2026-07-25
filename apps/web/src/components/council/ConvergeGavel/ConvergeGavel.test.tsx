import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ConvergePosition } from '../council.types';
import { ConvergeGavel } from './ConvergeGavel';
import * as stories from './ConvergeGavel.stories';

const { NoPositionsYet, Resolved } = composeStories(stories);

const POSITIONS: ConvergePosition[] = [
  { seatId: 'proposer-opus', role: 'proposer', content: 'Flag the store.' },
  { seatId: 'critic-opus', role: 'critic', content: 'Rehearse rollback first.' },
];

test('accept is disabled until a seat is selected, then resolves with that seat', async () => {
  const onResolve = vi.fn(async () => {});
  const screen = render(<ConvergeGavel positions={POSITIONS} onResolve={onResolve} />);

  const accept = screen.getByRole('button', { name: /Accept selected/ });
  await expect.element(accept).toBeDisabled();

  await screen.getByRole('radio', { name: "Adopt critic-opus's position" }).click();
  await expect.element(accept).toBeEnabled();
  await accept.click();

  expect(onResolve).toHaveBeenCalledWith('accept', { seatId: 'critic-opus' });
});

test('reject is confirmed through a dialog before it resolves', async () => {
  const onResolve = vi.fn(async () => {});
  const screen = render(<ConvergeGavel positions={POSITIONS} onResolve={onResolve} />);

  // The toolbar button opens the guard dialog; nothing dispatches yet.
  await screen.getByRole('button', { name: /Reject all/ }).click();
  const dialog = screen.getByRole('alertdialog');
  await expect.element(dialog).toBeInTheDocument();
  expect(onResolve).not.toHaveBeenCalled();

  // Confirming rejects every position and closes the run.
  await dialog.getByRole('button', { name: 'Reject and close' }).click();
  expect(onResolve).toHaveBeenCalledWith('reject', undefined);
});

test('judge is gated on a ruling, then resolves with the ruling note', async () => {
  const onResolve = vi.fn(async () => {});
  const screen = render(<ConvergeGavel positions={POSITIONS} onResolve={onResolve} />);

  const judge = screen.getByRole('button', { name: /Enter my ruling/ });
  await expect.element(judge).toBeDisabled();

  await screen.getByLabelText('Your ruling / reason').fill('Stage the cutover behind a flag.');
  await expect.element(judge).toBeEnabled();
  await judge.click();

  expect(onResolve).toHaveBeenCalledWith('judge', {
    note: 'Stage the cutover behind a flag.',
  });
});

test('a dispatch failure surfaces an inline error and re-enables the controls', async () => {
  const onResolve = vi.fn(async () => {
    throw new Error('no live session for this run');
  });
  const screen = render(<ConvergeGavel positions={POSITIONS} onResolve={onResolve} />);

  await screen.getByRole('button', { name: /Reject all/ }).click();
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Reject and close' }).click();
  await expect.element(screen.getByRole('alert')).toHaveTextContent('no live session for this run');
  await expect.element(screen.getByRole('button', { name: /Reject all/ })).toBeEnabled();
});

test('shows a waiting state before the seats have final positions', async () => {
  const screen = render(<NoPositionsYet />);
  await expect
    .element(screen.getByText("Waiting for the seats' final positions…"))
    .toBeInTheDocument();
});

test('once resolved, shows the recorded verdict read-only with no actions', async () => {
  const screen = render(<Resolved />);
  await expect.element(screen.getByText('Verdict recorded')).toBeInTheDocument();
  await expect.element(screen.getByText(/adopted seat "proposer-opus"/)).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /Accept selected/ }))
    .not.toBeInTheDocument();
});
