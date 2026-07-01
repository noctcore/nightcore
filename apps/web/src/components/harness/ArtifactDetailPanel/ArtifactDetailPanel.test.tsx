import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './ArtifactDetailPanel.stories';

const { Proposed, Applied, Dismissed } = composeStories(stories);

test('renders the target path and requests apply via the Apply button', async () => {
  const onApply = vi.fn();
  const screen = render(<Proposed onApply={onApply} />);
  await expect
    .element(
      screen.getByText('packages/eslint-plugin/src/rules/component-folder-structure.ts'),
    )
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /^apply$/i }).click();
  expect(onApply).toHaveBeenCalledWith('a1');
});

test('an applied artifact shows the applied state and no Apply action', async () => {
  const screen = render(<Applied />);
  await expect.element(screen.getByRole('button', { name: /applied/i })).toBeDisabled();
});

test('an applied eslint-class artifact offers arming it as a gauntlet check', async () => {
  const onArm = vi.fn();
  const screen = render(<Applied onArm={onArm} />);
  await screen.getByRole('button', { name: /arm gauntlet check/i }).click();
  expect(onArm).toHaveBeenCalledWith('a1');
});

test('a dismissed artifact offers a restore action', async () => {
  const onRestore = vi.fn();
  const screen = render(<Dismissed onRestore={onRestore} />);
  await screen.getByRole('button', { name: /restore/i }).click();
  expect(onRestore).toHaveBeenCalledWith('a1');
});
