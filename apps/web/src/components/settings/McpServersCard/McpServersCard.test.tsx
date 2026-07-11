import { composeStories } from '@storybook/react-vite';
import { StrictMode } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { McpServerEntry } from '@/lib/bridge';

import { McpServersCard } from './McpServersCard';
import * as stories from './McpServersCard.stories';

const { WithServers, Empty } = composeStories(stories);

const stdioServer: McpServerEntry = {
  id: 'srv-fs',
  name: 'filesystem',
  enabled: true,
  config: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { API_TOKEN: 'super-secret' },
  },
};

test('lists configured servers with their transport and target', async () => {
  const screen = render(<WithServers />);
  await expect.element(screen.getByText('filesystem')).toBeInTheDocument();
  await expect.element(screen.getByText('github')).toBeInTheDocument();
  await expect.element(screen.getByText('https://api.example.com/mcp')).toBeInTheDocument();
});

test('shows an empty hint when no servers are configured', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/no mcp servers configured/i))
    .toBeInTheDocument();
});

test('toggling a row emits the whole next list with that entry flipped', async () => {
  const onChange = vi.fn();
  const screen = render(<McpServersCard servers={[stdioServer]} onChange={onChange} />);
  await screen.getByRole('switch', { name: /disable filesystem/i }).click();
  expect(onChange).toHaveBeenCalledWith([{ ...stdioServer, enabled: false }]);
});

test('removing a server confirms then emits the list without it', async () => {
  const onChange = vi.fn();
  const screen = render(<McpServersCard servers={[stdioServer]} onChange={onChange} />);
  await screen.getByRole('button', { name: /remove filesystem/i }).click();
  // The confirm dialog gates the destructive action.
  await screen.getByRole('button', { name: 'Remove', exact: true }).click();
  expect(onChange).toHaveBeenCalledWith([]);
});

test('a duplicate name disables the save button (name uniqueness)', async () => {
  const onChange = vi.fn();
  const screen = render(
    <McpServersCard servers={[stdioServer]} onChange={onChange} />,
  );
  await screen.getByRole('button', { name: /add server/i }).click();
  await screen.getByLabelText('Server name').fill('filesystem');
  await screen.getByLabelText('Command').fill('node');
  // The modal's save action stays disabled because the name collides with the
  // existing entry (the header trigger is "Add server"; the save action is "Add").
  await expect.element(screen.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  expect(onChange).not.toHaveBeenCalled();
});

// React 19 StrictMode double-invokes state updaters in dev to surface impurity.
// The CRUD actions must keep their side effects (the `onChange` persistence write
// and the `newId()` id-mint) OUT of the setState updater, or a save/remove would
// fire `onChange` twice and an add would mint two different ids. These render under
// StrictMode explicitly (the plain `render` above does not) to guard that seam.
test('adding a server under StrictMode fires onChange once and mints one id', async () => {
  const onChange = vi.fn();
  const uuid = vi.spyOn(crypto, 'randomUUID');
  const screen = render(
    <StrictMode>
      <McpServersCard servers={[]} onChange={onChange} />
    </StrictMode>,
  );
  await screen.getByRole('button', { name: /add server/i }).click();
  await screen.getByLabelText('Server name').fill('notion');
  await screen.getByLabelText('Command').fill('npx');
  uuid.mockClear();
  await screen.getByRole('button', { name: 'Add', exact: true }).click();
  // A single persistence write and a single minted id — not one-per-invocation.
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(uuid).toHaveBeenCalledTimes(1);
  const next = (onChange.mock.calls[0]?.[0] ?? []) as McpServerEntry[];
  expect(next).toHaveLength(1);
  expect(next[0]?.id).toEqual(expect.any(String));
  expect(next[0]?.name).toBe('notion');
});

test('confirming a remove under StrictMode fires onChange exactly once', async () => {
  const onChange = vi.fn();
  const screen = render(
    <StrictMode>
      <McpServersCard servers={[stdioServer]} onChange={onChange} />
    </StrictMode>,
  );
  await screen.getByRole('button', { name: /remove filesystem/i }).click();
  await screen.getByRole('button', { name: 'Remove', exact: true }).click();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith([]);
});

test('editing a stdio server preserves an untouched masked secret', async () => {
  const onChange = vi.fn();
  const screen = render(<McpServersCard servers={[stdioServer]} onChange={onChange} />);
  await screen.getByRole('button', { name: /edit filesystem/i }).click();
  // The env value is masked in the editor — the plaintext secret is never echoed.
  const env = screen.getByLabelText('Environment');
  await expect.element(env).not.toHaveValue('API_TOKEN=super-secret');
  // Save without retyping the secret: the original plaintext is restored on write.
  await screen.getByRole('button', { name: 'Save changes' }).click();
  expect(onChange).toHaveBeenCalledTimes(1);
  const next = (onChange.mock.calls[0]?.[0] ?? []) as McpServerEntry[];
  expect(next[0]?.config).toMatchObject({
    transport: 'stdio',
    env: { API_TOKEN: 'super-secret' },
  });
});
