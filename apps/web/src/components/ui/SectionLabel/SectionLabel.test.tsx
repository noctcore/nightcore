import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SectionLabel.stories';

const { Default } = composeStories(stories);

test('renders the label text', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Run config')).toBeVisible();
});

test('appends a caller className onto the canonical class', async () => {
  const screen = render(<Default className="shrink-0" />);
  const el = screen.getByText('Run config').element();
  expect(el.className).toContain('font-mono');
  expect(el.className).toContain('tracking-[0.1em]');
  expect(el.className).toContain('shrink-0');
});
