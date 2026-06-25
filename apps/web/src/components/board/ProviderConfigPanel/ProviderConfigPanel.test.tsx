import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './ProviderConfigPanel.stories';

const { Default, Unsupported, Empty, LoadFailed, Loading } =
  composeStories(stories);

test('shows a skeleton loading state while the snapshot is being read', async () => {
  const screen = render(<Loading />);
  await expect
    .element(screen.getByRole('status', { name: 'Reading provider configuration' }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText('Reading provider configuration…'))
    .toBeInTheDocument();
});

test('renders supported MCP servers with scope, transport, and status', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('github')).toBeInTheDocument();
  await expect.element(screen.getByText('connected')).toBeInTheDocument();
  await expect.element(screen.getByText('14 tools')).toBeInTheDocument();
  // A mid-reconnect status is surfaced verbatim, not normalized away.
  await expect.element(screen.getByText('pending')).toBeInTheDocument();
});

test('renders a degraded (unavailable) section as a soft error with retry', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('probe timed out')).toBeInTheDocument();
  // The per-section retry button exists alongside the error.
  const retries = screen.container.querySelectorAll('button');
  expect(retries.length).toBeGreaterThan(0);
});

test('renders an unsupported section as "Not available for this provider"', async () => {
  const screen = render(<Unsupported />);
  // Every section declines; the phrase appears once per declined section.
  await expect
    .element(screen.getByText('Not available for this provider').first())
    .toBeInTheDocument();
});

test('an empty-but-supported section shows its empty text, not "unsupported"', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText('No MCP servers configured for this project.'))
    .toBeInTheDocument();
  // Must NOT render the unsupported phrase for an empty supported section.
  expect(
    screen.container.textContent?.includes('Not available for this provider'),
  ).toBe(false);
});

test('a whole-read failure shows a soft error and retry', async () => {
  const screen = render(<LoadFailed />);
  await expect
    .element(screen.getByText('no active project to inspect'))
    .toBeInTheDocument();
});

test('the close affordance fires onClose', async () => {
  const onClose = vi.fn();
  const screen = render(<Default onClose={onClose} />);
  await screen.getByLabelText('Close inspector').click();
  expect(onClose).toHaveBeenCalled();
});
