/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CouncilRouting } from '@nightcore/contracts';

import { RoutingPolicy } from './council-routing.js';

const OPEN: CouncilRouting = { mode: 'moderated-bus', edges: [] };
const SEAT_IDS = new Set(['a', 'b', 'c']);

describe('RoutingPolicy — the editable "A informs B" graph (issue #371)', () => {
  test('an EMPTY graph is OPEN — informers() returns null (every peer informs the seat)', () => {
    const policy = new RoutingPolicy(OPEN, SEAT_IDS);
    expect(policy.informers('a')).toBeNull();
    expect(policy.informers('b')).toBeNull();
    expect(policy.snapshot()).toEqual([]);
  });

  test('an EXPLICIT graph filters informers per recipient (and never itself)', () => {
    const policy = new RoutingPolicy(
      {
        mode: 'moderated-bus',
        edges: [
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
          // A self-loop is meaningless and is normalized away.
          { from: 'c', to: 'c' },
        ],
      },
      SEAT_IDS,
    );
    // c hears a + b (not itself).
    const cInformers = policy.informers('c');
    expect(cInformers).not.toBeNull();
    expect([...cInformers!].sort()).toEqual(['a', 'b']);
    // a and b have no incoming edge ⇒ they hear NO peers (explicit graph, not open).
    expect([...(policy.informers('a') ?? [])]).toEqual([]);
    expect([...(policy.informers('b') ?? [])]).toEqual([]);
  });

  test('the CONSTRUCTOR seed drops preset edges naming an unknown seat (issue #377)', () => {
    // Preset routing is trusted config, but the seed runs through the SAME validSeatIds
    // filter a live human edit does — a preset edge naming a seat the run does not define
    // is dropped at construction, not silently trusted (no seed/update asymmetry).
    const policy = new RoutingPolicy(
      {
        mode: 'moderated-bus',
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'ghost' }, // unknown recipient dropped at seed
          { from: 'nobody', to: 'b' }, // unknown source dropped at seed
        ],
      },
      SEAT_IDS,
    );
    expect(policy.snapshot()).toEqual([{ from: 'a', to: 'b' }]);
    expect([...(policy.informers('b') ?? [])]).toEqual(['a']);
  });

  test('update() REPLACES the graph and DROPS edges naming an unknown seat or a self-loop', () => {
    const policy = new RoutingPolicy(OPEN, SEAT_IDS);
    const applied = policy.update(
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'a' }, // self-loop dropped
        { from: 'a', to: 'zzz' }, // unknown recipient dropped
        { from: 'ghost', to: 'b' }, // unknown source dropped
        { from: 'a', to: 'b' }, // duplicate deduped
      ],
      SEAT_IDS,
    );
    expect(applied).toEqual([{ from: 'a', to: 'b' }]);
    expect([...(policy.informers('b') ?? [])]).toEqual(['a']);
    // The snapshot is a defensive COPY — mutating it can't corrupt the policy.
    const snap = policy.snapshot();
    snap.push({ from: 'x', to: 'y' });
    expect(policy.snapshot()).toEqual([{ from: 'a', to: 'b' }]);
  });

  test('update() to an EMPTY set restores the OPEN default', () => {
    const policy = new RoutingPolicy(
      {
        mode: 'moderated-bus',
        edges: [{ from: 'a', to: 'b' }],
      },
      SEAT_IDS,
    );
    expect(policy.informers('b')).not.toBeNull();
    policy.update([], SEAT_IDS);
    expect(policy.informers('b')).toBeNull();
  });

  test('describe() renders a deterministic, recipient-grouped summary for the transcript', () => {
    const policy = new RoutingPolicy(OPEN, SEAT_IDS);
    expect(policy.describe()).toContain('OPEN');
    policy.update(
      [
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
      SEAT_IDS,
    );
    // Sorted by recipient then source ⇒ stable regardless of input order.
    expect(policy.describe()).toBe('Routing updated: c ← a, b.');
  });
});
