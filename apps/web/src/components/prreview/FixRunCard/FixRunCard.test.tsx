import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { FixRunCard } from './FixRunCard';
import * as stories from './FixRunCard.stories';

const { Running, Committing, AwaitingPush, AwaitingPushBusy, Pushed, Failed } =
  composeStories(stories);

test('running renders a status live region with count + branch and a cancel action', async () => {
  const screen = render(<Running />);
  // The card is a `role="status"` live region (NOT an aria-label on a generic
  // div) so lifecycle flips are announced; the PR context rides as sr-only text.
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(/PR #128 fix in progress/);
  await expect
    .element(screen.getByText('Addressing 3 findings on fix/worktree-isolation'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel fix/i }))
    .toBeInTheDocument();
});

test('committing renders the spinner line as a status region with no actions', async () => {
  const screen = render(<Committing />);
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(/committing changes/i);
  await expect
    .element(screen.getByRole('button', { name: /cancel fix/i }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^push to pr$/i }))
    .not.toBeInTheDocument();
});

test('an unknown future status renders nothing (forward-compatible fallthrough)', async () => {
  const screen = render(
    <FixRunCard
      fix={{ ...Running.args!.fix!, status: 'archived-v2' }}
      pushing={false}
      onCancel={vi.fn()}
      onRequestPush={vi.fn()}
      onReReview={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole('status')).not.toBeInTheDocument();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
});

test('awaiting_push renders the summary as INERT text (markup stays literal), the push affordance, and the local-commit note', async () => {
  const screen = render(<AwaitingPush />);
  // The awaiting card is a status live region too, with the sr-only PR context.
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(/PR #128 fix awaiting push/);
  // Model text is never rendered as Markdown — the `**handle**` marks survive.
  await expect
    .element(screen.getByText(/\*\*handle\*\* the None case/))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^push to pr$/i }))
    .toBeEnabled();
  await expect
    .element(screen.getByText(/already committed locally on the branch/i))
    .toBeInTheDocument();
});

test('an in-flight push disables the push button', async () => {
  const screen = render(<AwaitingPushBusy />);
  const push = screen.getByRole('button', { name: /^push to pr$/i });
  await expect.element(push).toBeDisabled();
  await expect.element(push).toHaveAttribute('aria-busy', 'true');
});

test('pushed renders the success note with the branch and a re-review action', async () => {
  const screen = render(<Pushed />);
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(/fix pushed to/i);
  await expect.element(screen.getByText(/fix pushed to/i)).toBeInTheDocument();
  await expect
    .element(screen.getByText('fix/worktree-isolation'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /re-review/i }))
    .toBeInTheDocument();
});

test('failed renders the registry error and a dismiss affordance', async () => {
  const screen = render(<Failed />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/fix failed: the pr head is on a fork/i);
  await expect
    .element(screen.getByRole('button', { name: /dismiss fix status/i }))
    .toBeInTheDocument();
});

test('the card actions call their callbacks', async () => {
  const onCancel = vi.fn();
  const running = render(<Running onCancel={onCancel} />);
  await running.getByRole('button', { name: /cancel fix/i }).click();
  expect(onCancel).toHaveBeenCalledTimes(1);
  running.unmount();

  const onRequestPush = vi.fn();
  const awaiting = render(<AwaitingPush onRequestPush={onRequestPush} />);
  await awaiting.getByRole('button', { name: /^push to pr$/i }).click();
  expect(onRequestPush).toHaveBeenCalledTimes(1);
  awaiting.unmount();

  const onReReview = vi.fn();
  const pushed = render(<Pushed onReReview={onReReview} />);
  await pushed.getByRole('button', { name: /re-review/i }).click();
  expect(onReReview).toHaveBeenCalledTimes(1);
  pushed.unmount();

  const onDismiss = vi.fn();
  const failed = render(<Failed onDismiss={onDismiss} />);
  await failed.getByRole('button', { name: /dismiss fix status/i }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
