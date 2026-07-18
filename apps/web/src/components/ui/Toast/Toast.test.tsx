import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import { ToastProvider } from './Toast';
import { ttlFor, useToast } from './Toast.hooks';

/** Module-level counter so each "Note" click pushes a distinct, findable title. */
let counter = 1;

/** Harness: descendants reach the toast API exactly like app code does. */
function Trigger() {
  const { push, error } = useToast();
  return (
    <div className="p-4">
      <button onClick={() => error('Task failed', new Error('exit code 1'))}>Fail</button>
      <button onClick={() => push({ tone: 'success', title: 'Task merged' })}>Succeed</button>
      <button onClick={() => push({ tone: 'info', title: `Note ${counter++}` })}>Note</button>
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

test('errors linger longer than other tones (10s vs 6s)', () => {
  expect(ttlFor('error')).toBe(10000);
  expect(ttlFor('success')).toBe(6000);
  expect(ttlFor('info')).toBe(6000);
});

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

test('the visible stack caps at 4, dropping the oldest', async () => {
  counter = 1;
  const screen = renderHarness();
  const note = screen.getByRole('button', { name: 'Note' });
  // Push five notes: Note 1 (oldest) should fall off, Note 2–5 remain.
  for (let i = 0; i < 5; i++) await note.click();
  await expect.element(screen.getByText('Note 5')).toBeVisible();
  await expect.element(screen.getByText('Note 2')).toBeVisible();
  await expect.element(screen.getByText('Note 1')).not.toBeInTheDocument();
});
