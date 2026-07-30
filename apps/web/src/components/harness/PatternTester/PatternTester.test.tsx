import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PatternTester.stories';

const { Default, NoRules } = composeStories(stories);

test('stays quiet until a probe has input', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/shows whether an agent could write it/i))
    .toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Denied');
});

test('a protected path reports the denial and names the rule that fired', async () => {
  const screen = render(<Default />);
  await screen
    .getByRole('textbox', { name: 'Repo-relative path' })
    .fill('migrations/001_init.sql');
  await expect.element(screen.getByText('Denied', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('protectedPaths')).toBeInTheDocument();
  await expect.element(screen.getByText('migrations/**')).toBeInTheDocument();
});

test('an uncovered path reports that nothing protects it', async () => {
  const screen = render(<Default />);
  await screen.getByRole('textbox', { name: 'Repo-relative path' }).fill('src/main.ts');
  await expect
    .element(screen.getByText(/no rule covers this path — an agent may write it/i))
    .toBeInTheDocument();
});

test('a denied bash pattern is attributed to the pattern that matched', async () => {
  const screen = render(<Default />);
  await screen
    .getByRole('textbox', { name: 'Bash command line' })
    .fill('git commit --no-verify -m wip');
  await expect.element(screen.getByText('denyBashPatterns')).toBeInTheDocument();
  await expect.element(screen.getByText('--no-verify')).toBeInTheDocument();
});

test('a tool in both tiers reports the deny, not the softer ask', async () => {
  const screen = render(<Default />);
  await screen.getByRole('textbox', { name: 'Tool name' }).fill('WebSearch');
  await expect.element(screen.getByText('disallowedTools')).toBeInTheDocument();
  await expect.element(screen.getByText('Denied', { exact: true })).toBeInTheDocument();
});

test('an ask-tier tool renders the escalation, not a denial', async () => {
  const screen = render(<Default />);
  await screen.getByRole('textbox', { name: 'Tool name' }).fill('WebFetch');
  await expect.element(screen.getByText('Asks first')).toBeInTheDocument();
});

test('the implicit self-protection rule is surfaced even with an empty policy', async () => {
  const screen = render(<NoRules />);
  await screen
    .getByRole('textbox', { name: 'Repo-relative path' })
    .fill('.nightcore/harness.json');
  await expect.element(screen.getByText(/implicit self-protection/i)).toBeInTheDocument();
});

test('the path probe is reachable and editable from the keyboard', async () => {
  const screen = render(<Default />);
  const input = screen.getByRole('textbox', { name: 'Tool name' });
  await input.click();
  await expect.element(input).toHaveFocus();
  await input.fill('WebFetch');
  await expect.element(screen.getByText('Asks first')).toBeInTheDocument();
});
