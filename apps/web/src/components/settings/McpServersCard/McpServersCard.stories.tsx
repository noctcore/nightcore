import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { McpServerEntry } from '@/lib/bridge';
import { McpServersCard } from './McpServersCard';

const servers: McpServerEntry[] = [
  {
    id: 'srv-fs',
    name: 'filesystem',
    enabled: true,
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      env: { ROOT: '/tmp/work' },
    },
  },
  {
    id: 'srv-gh',
    name: 'github',
    enabled: false,
    config: {
      transport: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    },
  },
];

const meta = {
  title: 'Settings/McpServersCard',
  component: McpServersCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760 }}>
        <Story />
      </div>
    ),
  ],
  args: { servers, onChange: fn() },
} satisfies Meta<typeof McpServersCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithServers: Story = {};

export const Empty: Story = {
  args: { servers: [] },
};

/** Play test: toggling a row's enable switch emits the whole next list with the
 *  one entry flipped. */
export const TogglesEnabled: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('switch', { name: /disable filesystem/i }));
    await expect(args.onChange).toHaveBeenCalledWith([
      { ...servers[0], enabled: false },
      servers[1],
    ]);
  },
};

/** Play test: Add opens the editor; an http server with a name + URL saves as a
 *  new entry appended to the list. */
export const AddsAnHttpServer: Story = {
  args: { servers: [] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /add server/i }));
    await userEvent.type(canvas.getByLabelText('Server name'), 'linear');
    await userEvent.click(canvas.getByRole('button', { name: 'HTTP' }));
    await userEvent.type(canvas.getByLabelText('URL'), 'https://mcp.linear.app/sse');
    await userEvent.click(canvas.getByRole('button', { name: /^Add$/ }));
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    const call = (args.onChange as ReturnType<typeof fn>).mock.calls[0];
    const next = (call?.[0] ?? []) as McpServerEntry[];
    await expect(next).toHaveLength(1);
    const added = next[0];
    await expect(added).toBeDefined();
    await expect(added?.name).toBe('linear');
    await expect(added?.config).toMatchObject({
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
    });
  },
};
