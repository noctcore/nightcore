import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ToolCheck } from '@/lib/bridge';

import { folderBasename, toolReady } from './Onboarding.hooks';
import * as stories from './Onboarding.stories';

const { FirstRun, FolderSelected } = composeStories(stories);

test('derives a project name from the selected folder', () => {
  expect(folderBasename('/Users/shirone/Documents/Projects/nightcore')).toBe('nightcore');
  expect(folderBasename('/tmp/example/')).toBe('example');
  expect(folderBasename(null)).toBe('');
});

test('requires auth when a tool reports an auth state', () => {
  const base: ToolCheck = {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    authenticated: true,
    path: '/bin/claude',
    version: 'claude 3.9.2',
    detail: 'ok',
    fixHint: 'fix',
    fixCommand: 'fix',
  };
  expect(toolReady(base)).toBe(true);
  expect(toolReady({ ...base, authenticated: false })).toBe(false);
  expect(toolReady({ ...base, id: 'git', authenticated: null })).toBe(true);
  expect(toolReady({ ...base, installed: false })).toBe(false);
});

test('walks from welcome to environment and blocks until checks are ready', async () => {
  const screen = render(<FirstRun />);
  await expect.element(screen.getByText('Welcome to nightcore.')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('Environment check')).toBeInTheDocument();
  await expect.element(screen.getByText('Local environment is ready.')).toBeInTheDocument();
});

test('creates the first project from a selected repo', async () => {
  const screen = render(<FolderSelected />);
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('Local environment is ready.')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('First project')).toBeInTheDocument();
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('nightcore');
  await screen.getByRole('button', { name: 'Create project' }).click();
  await expect.element(screen.getByText('You are set.')).toBeInTheDocument();
});
