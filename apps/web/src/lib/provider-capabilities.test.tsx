import { expect, test } from 'vitest';

import type { ProviderCapabilities } from '@nightcore/contracts';

import {
  cacheProviderCapabilities,
  capabilitiesForProvider,
  CLAUDE_CAPABILITIES,
  getCachedCapabilities,
  runCeilingCaveatFor,
} from './provider-capabilities';

/** A Codex-like descriptor for the cache tests — derived from the Claude default via
 *  spread (the same convention the engine gate tests use), NOT a hand-copied source
 *  of truth: the real Codex matrix now comes over the wire (`get_capabilities`). */
const CODEX_LIKE: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'codex',
  label: 'Codex',
  supportsHarnessPolicy: false,
  supportsLedger: false,
  supportsHooks: false,
  supportsMaxTurns: false,
  supportsMaxBudget: false,
};

test('capabilitiesForProvider: no provider picked resolves to the passed fallback', () => {
  expect(capabilitiesForProvider(undefined, CLAUDE_CAPABILITIES)).toBe(CLAUDE_CAPABILITIES);
  expect(capabilitiesForProvider(null, CLAUDE_CAPABILITIES)).toBe(CLAUDE_CAPABILITIES);
  expect(capabilitiesForProvider(undefined, null)).toBeNull();
});

test('capabilitiesForProvider: claude resolves to the static default (or the claude fallback)', () => {
  expect(capabilitiesForProvider('claude', null)).toBe(CLAUDE_CAPABILITIES);
  // A live-fetched Claude fallback (same id) is preferred over the static default.
  const liveClaude: ProviderCapabilities = { ...CLAUDE_CAPABILITIES, label: 'Claude (live)' };
  expect(capabilitiesForProvider('claude', liveClaude)).toBe(liveClaude);
});

test('capabilitiesForProvider: an unfetched non-Claude provider FAILS SAFE to null, never the Claude fallback', () => {
  // The critical invariant (#296): a missing cache entry must NEVER mislabel a
  // non-Claude provider as Claude-capable (which would wrongly show the plan gate /
  // hide the governance warning). Degrade to null — fewer affordances, not more.
  expect(capabilitiesForProvider('gemini', CLAUDE_CAPABILITIES)).toBeNull();
});

test('capabilitiesForProvider: a cached (over-the-wire) descriptor wins', () => {
  expect(getCachedCapabilities('codex')).toBeNull();
  cacheProviderCapabilities(CODEX_LIKE);
  expect(getCachedCapabilities('codex')).toBe(CODEX_LIKE);
  // Even with a Claude fallback passed, the cached Codex descriptor is returned —
  // the fallback never masquerades as Codex.
  expect(capabilitiesForProvider('codex', CLAUDE_CAPABILITIES)).toBe(CODEX_LIKE);
});

test('cacheProviderCapabilities keys by the descriptor id, so a mismatched reply cannot masquerade', () => {
  // A fail-open Claude reply for a Codex request lands under `claude`, leaving the
  // requested `some-provider` absent (→ fail-safe null), never mislabeled.
  cacheProviderCapabilities({ ...CLAUDE_CAPABILITIES });
  expect(capabilitiesForProvider('some-provider', CLAUDE_CAPABILITIES)).toBeNull();
});

test('runCeilingCaveatFor: only caveats when the resolved provider lacks the ceilings', () => {
  // Claude enforces both — no caveat.
  expect(runCeilingCaveatFor(CLAUDE_CAPABILITIES)).toBeNull();
  // Unknown/loading capabilities fail open (no caveat — the flags only inform).
  expect(runCeilingCaveatFor(null)).toBeNull();
  // Codex enforces neither — caveat names the provider and says the limits are ignored.
  const caveat = runCeilingCaveatFor(CODEX_LIKE);
  expect(caveat).not.toBeNull();
  expect(caveat).toContain('Codex');
  expect(caveat).toContain('ignored');
});
