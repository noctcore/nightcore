import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ReadingDetailPanel.stories';

const { Default } = composeStories(stories);

const CONVERTED = {
  id: 'security-1',
  dimension: 'security' as const,
  grade: 'C' as const,
  title: 'Input validation is inconsistent',
  summary: 'Auth is solid but several handlers trust unvalidated request bodies.',
  rationale: null,
  location: null,
  suggestion: null,
  affectedFiles: [],
  tags: [],
  findings: [],
  confidence: null,
  fingerprint: 'fp',
  status: 'converted' as const,
  linkedTaskId: 'task-1',
};

test('renders the grade badge and the evidence', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/trusts req.body.id/i))
    .toBeInTheDocument();
  // The big grade badge shows the letter.
  expect(screen.container.textContent).toContain('C');
});

test('fires onHarden with the reading id from the "Harden this" button', async () => {
  const onHarden = vi.fn();
  const screen = render(<Default onHarden={onHarden} />);
  await screen.getByRole('button', { name: /harden this/i }).click();
  expect(onHarden).toHaveBeenCalledWith('security-1');
});

test('a hardened reading offers "Go to task" instead of "Harden this"', async () => {
  const screen = render(<Default reading={CONVERTED} />);
  // The single action swaps from "Harden this" to "Go to task" once hardened.
  await expect
    .element(screen.getByRole('button', { name: /go to task/i }))
    .toBeInTheDocument();
  expect(
    screen.container.querySelector('button')?.parentElement?.textContent ?? '',
  ).not.toContain('Harden this');
});
