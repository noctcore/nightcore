import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import type { Project } from '@/lib/bridge';

import { useProjectRemoval } from './useProjectRemoval.hooks';

const project = {
  id: 'nightcore',
  name: 'Nightcore',
  path: 'X:\\dev\\nightcore',
  branch: 'main',
  icon: null,
  customIconPath: null,
} as Project;

function RemovalHarness({ remove }: { remove: (id: string) => void }) {
  const removal = useProjectRemoval([project], remove);
  return (
    <>
      <span>{removal.pending?.name ?? 'none'}</span>
      <button type="button" onClick={() => removal.request(project.id)}>Request</button>
      <button type="button" onClick={removal.confirm}>Confirm</button>
      <button type="button" onClick={removal.cancel}>Cancel</button>
    </>
  );
}

test('only removes the requested project after confirmation', async () => {
  const remove = vi.fn();
  const screen = render(<RemovalHarness remove={remove} />);

  await userEvent.click(screen.getByRole('button', { name: 'Request' }).element());
  await expect.element(screen.getByText('Nightcore')).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }).element());
  expect(remove).toHaveBeenCalledWith(project.id);
  await expect.element(screen.getByText('none')).toBeInTheDocument();
});

test('cancelling clears the request without removing the project', async () => {
  const remove = vi.fn();
  const screen = render(<RemovalHarness remove={remove} />);

  await userEvent.click(screen.getByRole('button', { name: 'Request' }).element());
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }).element());

  await expect.element(screen.getByText('none')).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
});
