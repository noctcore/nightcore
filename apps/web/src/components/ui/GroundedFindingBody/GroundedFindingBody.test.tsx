import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { inferLanguageFromFile } from './GroundedFindingBody';
import * as stories from './GroundedFindingBody.stories';

const { Default, InertWithExtraSections, Dismissed } = composeStories(stories);

test('renders the shared sections: title, location, rationale, files, tags', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('Unawaited promise drops errors'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText('src/app/tasks.ts:42'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Why it matters')).toBeInTheDocument();
  await expect.element(screen.getByText('Suggested fix')).toBeInTheDocument();
  await expect.element(screen.getByText('Affected files')).toBeInTheDocument();
  await expect.element(screen.getByText('error-handling')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /convert to task/i }))
    .toBeInTheDocument();
});

test('renders extra slot sections and the inert description', async () => {
  const screen = render(<InertWithExtraSections />);
  await expect
    .element(screen.getByText('Model-authored body rendered as inert text.'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Corroboration')).toBeInTheDocument();
  await expect.element(screen.getByText('Evidence')).toBeInTheDocument();
});

test('a dismissed item shows Restore instead of Dismiss', async () => {
  const screen = render(<Dismissed />);
  await expect
    .element(screen.getByRole('button', { name: /restore/i }))
    .toBeInTheDocument();
});

test('a null item renders the closed empty shell (content retained pattern)', async () => {
  const onClose = vi.fn();
  const screen = render(
    <Default item={null} open={false} onClose={onClose} />,
  );
  await expect
    .element(screen.getByText('Unawaited promise drops errors'))
    .not.toBeInTheDocument();
});

test('inferLanguageFromFile maps extensions and defaults to ts', () => {
  expect(inferLanguageFromFile('src/a/b.rs')).toBe('rs');
  expect(inferLanguageFromFile('src/a/b.test.tsx')).toBe('tsx');
  expect(inferLanguageFromFile('Makefile')).toBe('makefile');
  expect(inferLanguageFromFile(undefined)).toBe('ts');
  expect(inferLanguageFromFile(null)).toBe('ts');
});
