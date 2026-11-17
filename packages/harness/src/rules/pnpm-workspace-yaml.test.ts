import { describe, expect, test } from 'bun:test';

import { workspaceList, workspaceScalar } from './pnpm-workspace-yaml.js';

const TEXT = [
  '# A comment about the gate.',
  'minimumReleaseAge: 10080 # minutes',
  '',
  "trustPolicy: 'no-downgrade'",
  'packages:',
  "  - 'apps/*'",
  '',
  'trustPolicyExclude:',
  '  # Reason for the first two,',
  '  # over two lines.',
  "  - 'a@1.0.0'",
  '  - b@2.0.0 || 3.0.0',
  '',
  '  # Reason for c.',
  '  - "c@4.0.0"',
  '# The next key.',
  'engineStrict: true',
  'inline: [x, y]',
  'empty:',
].join('\n');

describe('the pnpm-workspace.yaml reader', () => {
  test('reads a top-level scalar without its quotes or trailing comment, and null when the key is absent', () => {
    expect(workspaceScalar(TEXT, 'minimumReleaseAge')).toBe('10080');
    expect(workspaceScalar(TEXT, 'trustPolicy')).toBe('no-downgrade');
    expect(workspaceScalar(TEXT, 'engineStrict')).toBe('true');
    expect(workspaceScalar(TEXT, 'strictDepBuilds')).toBeNull();
  });

  test('reads a block list item by item, each with the comment block written above it', () => {
    const list = workspaceList(TEXT, 'trustPolicyExclude');
    expect(list?.items).toEqual([
      { value: 'a@1.0.0', reason: 'Reason for the first two, over two lines.' },
      { value: 'b@2.0.0 || 3.0.0', reason: 'Reason for the first two, over two lines.' },
      { value: 'c@4.0.0', reason: 'Reason for c.' },
    ]);
    expect(list?.unreadable).toEqual([]);
  });

  test('ends a run of items at a blank line, so an item after it does not borrow the reason above', () => {
    const list = workspaceList('k:\n  # Why a.\n  - a@1.0.0\n\n  - b@1.0.0\n', 'k');
    expect(list?.items).toEqual([
      { value: 'a@1.0.0', reason: 'Why a.' },
      { value: 'b@1.0.0', reason: '' },
    ]);
  });

  test('says a list it cannot read is unreadable instead of returning it empty, and null for an absent key', () => {
    expect(workspaceList(TEXT, 'inline')).toEqual({ items: [], unreadable: ['[x, y]'] });
    expect(workspaceList(TEXT, 'empty')).toEqual({ items: [], unreadable: [] });
    expect(workspaceList(TEXT, 'missing')).toBeNull();
    expect(workspaceList('k:\n  key: value\n', 'k')?.unreadable).toEqual(['key: value']);
  });
});
