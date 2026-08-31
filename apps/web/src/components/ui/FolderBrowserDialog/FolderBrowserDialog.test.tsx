import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import type { DirectoryListing } from '@/lib/bridge';

import { FolderBrowserDialog } from './FolderBrowserDialog';

// Control `list_directory` precisely (navigation, error, empty) via a keyed fake
// filesystem; keep the rest of the bridge real.
const listDirMock = vi.fn<(path: string | null, includeHidden: boolean) => Promise<DirectoryListing>>();
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    listDirectory: (path: string | null, includeHidden: boolean) => listDirMock(path, includeHidden),
  };
});

const RECENTS_KEY = 'nc:folder-browser:recents';

function listing(current: string, names: string[], parent: string | null): DirectoryListing {
  return {
    currentPath: current,
    parentPath: parent,
    entries: names.map((name) => ({ name, path: `${current}/${name}`, isGitRepo: false })),
  };
}

const HOME = '/Users/you';

/** A keyed fake fs: home has projects/Documents; projects has nightcore; a distinct
 *  `work` dir (leaf name absent from the home listing) drives the recents test. */
function wireFakeFs() {
  listDirMock.mockImplementation((path) => {
    const p = path ?? HOME;
    if (p === HOME) return Promise.resolve(listing(HOME, ['projects', 'Documents'], '/Users'));
    if (p === `${HOME}/projects`)
      return Promise.resolve(listing(`${HOME}/projects`, ['nightcore'], HOME));
    if (p === `${HOME}/work`) return Promise.resolve(listing(`${HOME}/work`, ['widget'], HOME));
    return Promise.resolve(listing(p, [], HOME));
  });
}

afterEach(() => {
  listDirMock.mockReset();
  window.localStorage.clear();
});

test('lists the home directory on open', async () => {
  wireFakeFs();
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
  await expect.element(screen.getByText('projects')).toBeInTheDocument();
  await expect.element(screen.getByText('Documents')).toBeInTheDocument();
  expect(listDirMock).toHaveBeenCalledWith(null, false);
});

test('single-click descends into a folder', async () => {
  wireFakeFs();
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
  await screen.getByText('projects').click();
  // After the double-click window elapses, the descend lists the child folder.
  await expect.element(screen.getByText('nightcore')).toBeInTheDocument();
});

test('double-click picks the folder (onSelect + close)', async () => {
  wireFakeFs();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const screen = render(<FolderBrowserDialog open onClose={onClose} onSelect={onSelect} />);
  await expect.element(screen.getByText('projects')).toBeInTheDocument();
  await userEvent.dblClick(screen.getByText('projects').element());
  expect(onSelect).toHaveBeenCalledWith(`${HOME}/projects`);
  expect(onClose).toHaveBeenCalled();
});

test('the footer button selects the current folder', async () => {
  wireFakeFs();
  const onSelect = vi.fn();
  const screen = render(
    <FolderBrowserDialog open onClose={vi.fn()} onSelect={onSelect} selectLabel="Open here" />,
  );
  await expect.element(screen.getByText('projects')).toBeInTheDocument();
  await screen.getByRole('button', { name: /Open here/i }).click();
  expect(onSelect).toHaveBeenCalledWith(HOME);
});

test('search filters the current listing', async () => {
  wireFakeFs();
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
  await expect.element(screen.getByText('Documents')).toBeInTheDocument();
  await screen.getByLabelText('Filter folders in this directory').fill('doc');
  await expect.element(screen.getByText('Documents')).toBeInTheDocument();
  await expect.element(screen.getByText('projects')).not.toBeInTheDocument();
});

test('a listing error surfaces inline', async () => {
  listDirMock.mockRejectedValue('permission denied reading /root');
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
  await expect.element(screen.getByText(/permission denied reading/i)).toBeInTheDocument();
});

test('an empty directory shows the empty note', async () => {
  listDirMock.mockResolvedValue(listing(HOME, [], '/Users'));
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
  await expect.element(screen.getByText('No sub-folders here.')).toBeInTheDocument();
});

test('recent folders render, jump, and can be removed', async () => {
  wireFakeFs();
  // A recent whose leaf ("work") is absent from the home listing, so the chip is
  // unambiguous vs. the folder rows.
  window.localStorage.setItem(RECENTS_KEY, JSON.stringify([`${HOME}/work`]));
  const screen = render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={vi.fn()} />);

  // The chip shows the folder's leaf name and jumps to it on click.
  await expect.element(screen.getByRole('button', { name: /^work$/ })).toBeInTheDocument();
  await screen.getByRole('button', { name: /^work$/ }).click();
  await expect.element(screen.getByText('widget')).toBeInTheDocument();

  // Removing the recent drops it from the list + storage.
  await screen.getByRole('button', { name: /Remove work from recent/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /Remove work from recent/i }))
    .not.toBeInTheDocument();
  expect(window.localStorage.getItem(RECENTS_KEY)).toBe(JSON.stringify([]));
});

test('Cmd/Ctrl+Enter selects the current folder', async () => {
  wireFakeFs();
  const onSelect = vi.fn();
  render(<FolderBrowserDialog open onClose={vi.fn()} onSelect={onSelect} />);
  // Wait for the home listing so currentPath is set.
  await vi.waitFor(() => expect(listDirMock).toHaveBeenCalled());
  await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(HOME));
});
