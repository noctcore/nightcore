import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Markdown } from './Markdown';

const SAMPLE = `# Verdict

The change looks **solid**. A few notes:

- Handles the empty case
- Adds a regression test
- Uses the existing \`summarizeInput\` helper

\`\`\`ts
const ok = summarizeInput({ command: 'git status' });
\`\`\`

See [the contract](https://example.com) for details.`;

const meta = {
  title: 'UI/Markdown',
  component: Markdown,
  decorators: [
    (Story) => (
      <div style={{ width: 460 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rich: Story = { args: { children: SAMPLE } };

export const InlineOnly: Story = {
  args: { children: 'A plain line with `inline code` and **bold** text.' },
};

/** Play test: markdown is rendered as real HTML (heading + list + code). */
export const RendersHtml: Story = {
  args: { children: SAMPLE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: /verdict/i })).toBeInTheDocument();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3);
    await expect(canvas.getByRole('link', { name: /the contract/i })).toBeInTheDocument();
  },
};

/** Play test: a script injection is stripped by the sanitizer. */
export const SanitizesScripts: Story = {
  args: { children: 'Hello <script>window.__pwned = true;</script> world' },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('script')).toBeNull();
    await expect(canvasElement.textContent).toContain('Hello');
  },
};
