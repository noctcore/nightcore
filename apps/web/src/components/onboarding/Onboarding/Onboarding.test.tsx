import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
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
  expect(toolReady({ ...base, id: 'codex', label: 'Codex CLI' })).toBe(true);
  expect(toolReady({ ...base, id: 'git', authenticated: null })).toBe(true);
  expect(toolReady({ ...base, installed: false })).toBe(false);
});

test('teaches the five-stage model between welcome and the environment gate', async () => {
  const screen = render(<FirstRun />);
  await expect.element(screen.getByText('Welcome to nightcore.')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Continue' }).click();
  // The stage diagram is a step of its own — the model is transmitted before the
  // user is ever handed a board (issue #404).
  await expect.element(screen.getByText('How Nightcore works')).toBeInTheDocument();
  await expect.element(screen.getByRole('heading', { name: 'Intake' })).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('Environment check')).toBeInTheDocument();
  await expect.element(screen.getByText('Local environment is ready.')).toBeInTheDocument();
});

test('creates the first project from a selected repo and offers two exits', async () => {
  const onComplete = vi.fn();
  const screen = render(<FolderSelected onComplete={onComplete} />);
  await screen.getByRole('button', { name: 'Continue' }).click();
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('Local environment is ready.')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Continue' }).click();
  await expect.element(screen.getByText('First project')).toBeInTheDocument();
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('nightcore');
  await screen.getByRole('button', { name: 'Create project' }).click();
  await expect.element(screen.getByText('You are set.')).toBeInTheDocument();

  // Ready no longer auto-advances, so both exits are reachable: the first-scan CTA
  // hands off to the Understand stage, the primary button to the board.
  await screen.getByRole('button', { name: 'Run a first scan' }).click();
  expect(onComplete).toHaveBeenCalledWith('scan');
});
