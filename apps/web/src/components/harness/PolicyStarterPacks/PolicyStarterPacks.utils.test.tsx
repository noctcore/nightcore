import { expect, test } from 'vitest';

import { diagnosePolicyEntry } from '@nightcore/contracts';

import type { PolicyPackKey, PolicyPackLists } from './PolicyStarterPacks.types';
import {
  packApplied,
  packRuleCount,
  packsForProfile,
  STARTER_PACKS,
} from './PolicyStarterPacks.utils';

const EMPTY: PolicyPackLists = {
  protectedPaths: [],
  denyBashPatterns: [],
  denyReadPaths: [],
  disallowedTools: [],
  askTools: [],
};

/** Which diagnostic tier each pack-writable field is judged by — mirrors the
 *  editor's field table. */
const TIER: Record<PolicyPackKey, Parameters<typeof diagnosePolicyEntry>[0]> = {
  protectedPaths: 'path',
  denyReadPaths: 'path',
  denyBashPatterns: 'bash-regex',
  disallowedTools: 'tool',
  askTools: 'tool',
};

test('no shipped pack entry is a rule the editor would call dead', () => {
  // The load-bearing guarantee: a preset that ships a silently-dead rule would be
  // the #400 bug with a friendly button on it.
  for (const pack of STARTER_PACKS) {
    for (const [key, entries] of Object.entries(pack.entries)) {
      for (const entry of entries ?? []) {
        const diagnostic = diagnosePolicyEntry(TIER[key as PolicyPackKey], entry);
        expect(
          diagnostic?.severity === 'error' ? `${pack.id}/${entry}: ${diagnostic.message}` : null,
        ).toBeNull();
      }
    }
  }
});

test('no pack writes allowTools (a preset must never loosen the rails)', () => {
  for (const pack of STARTER_PACKS) {
    expect(Object.keys(pack.entries)).not.toContain('allowTools');
  }
});

test('every pack contributes at least one rule and has a unique id', () => {
  const ids = STARTER_PACKS.map((pack) => pack.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const pack of STARTER_PACKS) {
    expect(packRuleCount(pack)).toBeGreaterThan(0);
  }
});

test('an unscanned project is offered the universal packs only', () => {
  const offered = packsForProfile(null);
  expect(offered.length).toBeGreaterThan(0);
  expect(offered.every((pack) => pack.appliesTo === null)).toBe(true);
  expect(offered.map((p) => p.id)).not.toContain('rust-workspace');
});

test('profile keying adds exactly the packs the repo shape earns', () => {
  const rustTauriMonorepo = packsForProfile({
    isMonorepo: true,
    languages: ['typescript', 'Rust'],
    frameworks: ['react', 'Tauri'],
  }).map((pack) => pack.id);
  expect(rustTauriMonorepo).toContain('rust-workspace');
  expect(rustTauriMonorepo).toContain('tauri-desktop');
  expect(rustTauriMonorepo).toContain('monorepo-boundaries');

  const plain = packsForProfile({
    isMonorepo: false,
    languages: ['typescript'],
    frameworks: ['react'],
  }).map((pack) => pack.id);
  expect(plain).not.toContain('rust-workspace');
  expect(plain).not.toContain('tauri-desktop');
  expect(plain).not.toContain('monorepo-boundaries');
});

test('packApplied is false for an empty draft and true once every entry is present', () => {
  const pack = STARTER_PACKS.find((p) => p.id === 'no-web-egress')!;
  expect(packApplied(pack, EMPTY)).toBe(false);
  expect(packApplied(pack, { ...EMPTY, disallowedTools: ['WebFetch'] })).toBe(false);
  expect(
    packApplied(pack, { ...EMPTY, disallowedTools: [' WebFetch ', 'WebSearch', 'Bash'] }),
  ).toBe(true);
});
