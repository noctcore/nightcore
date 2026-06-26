import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './GauntletResults.stories';

const { NotRunYet, Passed, Failed, StructureLockPassed, StructureLockFailed } =
  composeStories(stories);

test('prompts to run the gauntlet before it has been run', async () => {
  const screen = render(<NotRunYet />);
  await expect.element(screen.getByText(/Run the gauntlet to gate the merge/)).toBeInTheDocument();
});

test('lists the passing step commands when all pass', async () => {
  const screen = render(<Passed />);
  await expect.element(screen.getByText('Passed')).toBeInTheDocument();
  await expect.element(screen.getByText('bun run typecheck')).toBeInTheDocument();
  await expect.element(screen.getByText('bun run test')).toBeInTheDocument();
});

test('names the failed step and shows its exit code', async () => {
  const screen = render(<Failed />);
  await expect.element(screen.getByText(/Failed at test/)).toBeInTheDocument();
  await expect.element(screen.getByText('exit 1')).toBeInTheDocument();
});

test('renders the passing structure-lock harness checks', async () => {
  const screen = render(<StructureLockPassed />);
  await expect.element(screen.getByText('Structure lock')).toBeInTheDocument();
  await expect.element(screen.getByText('folder-per-component')).toBeInTheDocument();
  await expect.element(screen.getByText('no-cross-feature-imports')).toBeInTheDocument();
});

test('names the failed structure-lock check', async () => {
  const screen = render(<StructureLockFailed />);
  await expect
    .element(screen.getByText(/Failed at folder-per-component/))
    .toBeInTheDocument();
});

test('fires onRun when Run checks is clicked', async () => {
  const onRun = vi.fn();
  const screen = render(<NotRunYet onRun={onRun} />);
  await screen.getByRole('button', { name: /run checks/i }).click();
  expect(onRun).toHaveBeenCalled();
});
