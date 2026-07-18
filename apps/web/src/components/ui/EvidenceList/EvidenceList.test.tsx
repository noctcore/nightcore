import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './EvidenceList.stories';

const { Default, LocationOnly } = composeStories(stories);

test('renders detail text alongside its grounded location with symbol', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/No error boundary wraps the route loader/))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/src\/routes\/board\.tsx:42-51 · BoardRoute/))
    .toBeInTheDocument();
});

test('renders a detail-only row when the location is null', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText(/Retry has no backoff/)).toBeInTheDocument();
});

test('renders location-only rows (no detail prefix) with the symbol appended', async () => {
  const screen = render(<LocationOnly />);
  await expect
    .element(screen.getByText(/src\/lib\/scan-run\/deep\.ts:9 · deepModeMeta/))
    .toBeInTheDocument();
});
