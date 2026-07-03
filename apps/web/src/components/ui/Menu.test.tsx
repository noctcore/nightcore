import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { IconButton } from './IconButton';
import { DotsIcon } from './icons';
import { Menu } from './Menu';

function setup(onRename = vi.fn(), onRemove = vi.fn()) {
  return render(
    <Menu
      label="Project menu"
      trigger={
        <IconButton label="Open menu">
          <DotsIcon size={16} />
        </IconButton>
      }
      items={[
        { label: 'Rename', onClick: onRename },
        { label: 'Remove', onClick: onRemove, destructive: true },
      ]}
    />,
  );
}

test('is closed until the trigger is clicked', async () => {
  const screen = setup();
  expect(screen.container.querySelector('[role="menu"]')).toBeNull();
  await screen.getByRole('button', { name: 'Open menu' }).click();
  await expect.element(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
});

test('selecting an item invokes its handler and closes the menu', async () => {
  const onRemove = vi.fn();
  const screen = setup(vi.fn(), onRemove);
  await screen.getByRole('button', { name: 'Open menu' }).click();
  await screen.getByRole('menuitem', { name: 'Remove' }).click();
  expect(onRemove).toHaveBeenCalled();
  expect(screen.container.querySelector('[role="menu"]')).toBeNull();
});

test('Escape closes the menu', async () => {
  const screen = setup();
  await screen.getByRole('button', { name: 'Open menu' }).click();
  await expect.element(screen.getByRole('menu')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.container.querySelector('[role="menu"]')).toBeNull();
});

test('closes when focus leaves the menu (Tab-out)', async () => {
  // Tabbing off the last menuitem moves focus to a control outside the menu; the
  // focus-out handler closes it so focus is never stranded behind the open panel.
  const screen = render(
    <div>
      <Menu
        label="Project menu"
        trigger={
          <IconButton label="Open menu">
            <DotsIcon size={16} />
          </IconButton>
        }
        items={[
          { label: 'Rename', onClick: vi.fn() },
          { label: 'Remove', onClick: vi.fn(), destructive: true },
        ]}
      />
      <button type="button" data-testid="after">
        after
      </button>
    </div>,
  );
  await screen.getByRole('button', { name: 'Open menu' }).click();
  await expect.element(screen.getByRole('menu')).toBeInTheDocument();
  (screen.getByTestId('after').element() as HTMLElement).focus();
  await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
});
