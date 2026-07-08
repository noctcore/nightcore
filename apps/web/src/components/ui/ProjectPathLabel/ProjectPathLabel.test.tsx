import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { ProjectPathLabel } from './ProjectPathLabel';
import {
  compactProjectPath,
  friendlyProjectPath,
} from './ProjectPathLabel.hooks';

test.each([
  ['\\\\?\\X:\\repo', 'X:\\repo'],
  ['\\\\?\\UNC\\server\\share\\repo', '\\\\server\\share\\repo'],
  ['/Users/dev/repo', '/Users/dev/repo'],
])('formats the full display path %s', (path, expected) => {
  expect(friendlyProjectPath(path)).toBe(expected);
});

test.each([
  ['\\\\?\\X:\\shiro-suite\\shiranami', 'shiro-suite\\shiranami'],
  ['\\\\?\\UNC\\server\\share\\repo', 'share\\repo'],
  ['/Users/dev/repo/', 'dev/repo'],
  ['/repo', 'repo'],
  ['/', '/'],
  ['C:\\', 'C:\\'],
])('compacts %s to %s', (path, expected) => {
  expect(compactProjectPath(path)).toBe(expected);
});

test('exposes the friendly full path through an accessible tooltip', async () => {
  const screen = render(
    <ProjectPathLabel path={'\\\\?\\X:\\shiro-suite\\shiranami'} />,
  );

  const trigger = screen.getByText('shiro-suite\\shiranami', { exact: true });
  await expect.element(trigger).toBeInTheDocument();
  const tooltip = screen.getByRole('tooltip');
  await expect.element(tooltip).toHaveTextContent('X:\\shiro-suite\\shiranami');

  expect(trigger.element()).toHaveAttribute('type', 'button');
  expect(trigger.element()).toHaveAttribute('aria-describedby', tooltip.element().id);
  trigger.element().focus();
  await expect.element(tooltip).toBeVisible();
});

test('shows the tooltip when a containing project button receives focus', async () => {
  const screen = render(
    <button type="button" className="group/path-trigger">
      Project
      <ProjectPathLabel path="/Users/dev/nightcore" focusable={false} />
    </button>,
  );

  screen.getByRole('button', { name: /project/i }).element().focus();
  await expect.element(screen.getByRole('tooltip')).toBeVisible();
});
