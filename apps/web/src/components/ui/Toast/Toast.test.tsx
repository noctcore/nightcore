import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import { ToastProvider } from './Toast';
import { useToast } from './Toast.hooks';

/** Harness: descendants reach the toast API exactly like app code does. */
function Trigger() {
  const { push, error } = useToast();
  return (
    <div className="p-4">
      <button onClick={() => error('Task failed', new Error('exit code 1'))}>Fail</button>
      <button onClick={() => push({ tone: 'success', title: 'Task merged' })}>Succeed</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <MotionProvider>
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    </MotionProvider>,
  );
}

test('an error push renders a role="alert" toast with the title and coerced detail', async () => {
  const screen = renderHarness();
  await screen.getByRole('button', { name: 'Fail' }).click();
  const alert = screen.getByRole('alert');
  await expect.element(alert).toHaveTextContent('Task failed');
  await expect.element(alert).toHaveTextContent('exit code 1');
});

test('a non-error push announces politely via role="status"', async () => {
  const screen = renderHarness();
  await screen.getByRole('button', { name: 'Succeed' }).click();
  await expect.element(screen.getByRole('status')).toHaveTextContent('Task merged');
});

test('the dismiss button removes the toast from the stack', async () => {
  const screen = renderHarness();
  await screen.getByRole('button', { name: 'Fail' }).click();
  await expect.element(screen.getByRole('alert')).toBeVisible();
  await screen.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
});
