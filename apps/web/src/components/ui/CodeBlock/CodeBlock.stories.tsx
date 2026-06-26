import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { CodeBlock } from './CodeBlock';

const TS_SAMPLE = `export function greet(name: string): string {
  // a friendly hello
  return \`Hello, \${name}!\`;
}`;

const JSON_SAMPLE = `{
  "model": "opus-4.8",
  "effort": "high",
  "lenses": 8
}`;

const BASH_SAMPLE = `#!/usr/bin/env bash
set -euo pipefail
bun run --filter @nightcore/web typecheck`;

const meta = {
  title: 'UI/CodeBlock',
  component: CodeBlock,
  args: { code: TS_SAMPLE, language: 'ts' },
  decorators: [
    (Story) => (
      <div style={{ width: 560, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** TypeScript — highlighted once the lazy Shiki highlighter resolves. */
export const TypeScript: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('pre.shiki')).not.toBeNull());
    await expect(canvas.getByText(/Hello/)).toBeInTheDocument();
  },
};

export const Json: Story = { args: { code: JSON_SAMPLE, language: 'json' } };

export const Bash: Story = { args: { code: BASH_SAMPLE, language: 'bash' } };

/** Unknown language → plain text, never throws. */
export const UnknownLanguage: Story = {
  args: { code: 'plain text, no grammar', language: 'cobol' },
};
