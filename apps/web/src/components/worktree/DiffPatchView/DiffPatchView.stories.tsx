import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { DiffPatchView } from './DiffPatchView';

/** A modified file: header/meta lines, a hunk header, and mixed add/del/context
 *  content — the common case. */
const MODIFIED_PATCH = `diff --git a/apps/web/src/lib/diff.ts b/apps/web/src/lib/diff.ts
index 1a2b3c4..5d6e7f8 100644
--- a/apps/web/src/lib/diff.ts
+++ b/apps/web/src/lib/diff.ts
@@ -1,6 +1,7 @@
 import { compare } from './compare';

-export function diff(a: string) {
+export function diff(a: string, b: string) {
+  // compare both sides now
   return compare(a, b);
 }
`;

/** An untracked new file: the backend synthesizes an all-additions patch. */
const UNTRACKED_PATCH = `diff --git a/scratch/notes.md b/scratch/notes.md
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/scratch/notes.md
@@ -0,0 +1,3 @@
+# Notes
+
+- first note
`;

/** The binary sentinel the backend returns in place of a patch. */
const BINARY_PATCH = 'Binary file assets/logo.png (not shown)';

const meta = {
  title: 'Worktree/DiffPatchView',
  component: DiffPatchView,
  parameters: { layout: 'padded' },
  args: { patch: MODIFIED_PATCH },
} satisfies Meta<typeof DiffPatchView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Modified: Story = {};

export const Untracked: Story = { args: { patch: UNTRACKED_PATCH } };

export const Binary: Story = { args: { patch: BINARY_PATCH } };

export const Empty: Story = { args: { patch: '' } };

export const Loading: Story = { args: { patch: null, loading: true } };

/** Play test: a modified patch colors the added and removed lines and preserves
 *  the hunk header. Regexes (not exact strings) sidestep the whitespace-collapse
 *  in testing-library's text normalizer. */
export const RendersModifiedLines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/\/\/ compare both sides now/)).toBeInTheDocument();
    // The removed signature (no `, b: string`) uniquely identifies the `-` line.
    await expect(canvas.getByText(/diff\(a: string\) \{/)).toBeInTheDocument();
    await expect(canvas.getByText(/@@ -1,6 \+1,7 @@/)).toBeInTheDocument();
  },
};

/** Play test: an untracked file renders its all-additions body. */
export const RendersUntrackedAdditions: Story = {
  args: { patch: UNTRACKED_PATCH },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('+# Notes')).toBeInTheDocument();
    await expect(canvas.getByText('+- first note')).toBeInTheDocument();
  },
};

/** Play test: a binary blob surfaces its sentinel note, not diff lines. */
export const RendersBinaryNote: Story = {
  args: { patch: BINARY_PATCH },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Binary file assets/logo.png (not shown)')).toBeInTheDocument();
  },
};
