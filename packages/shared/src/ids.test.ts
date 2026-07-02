/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { createMonotonicCounter, createRequestIdFactory } from './ids.js';

describe('createMonotonicCounter', () => {
  test('starts at 1 by default, leaving 0 as a sentinel', () => {
    const next = createMonotonicCounter();
    expect(next()).toBe(1);
    expect(next()).toBe(2);
    expect(next()).toBe(3);
  });

  test('honors a custom start value', () => {
    const next = createMonotonicCounter(100);
    expect(next()).toBe(100);
    expect(next()).toBe(101);
  });

  test('never repeats and only climbs', () => {
    const next = createMonotonicCounter();
    const seen = new Set<number>();
    let previous = 0;
    for (let i = 0; i < 1000; i++) {
      const id = next();
      expect(id).toBeGreaterThan(previous);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      previous = id;
    }
    expect(seen.size).toBe(1000);
  });

  test('independent counters do not share state', () => {
    const a = createMonotonicCounter();
    const b = createMonotonicCounter();
    expect(a()).toBe(1);
    expect(a()).toBe(2);
    expect(b()).toBe(1);
  });
});

describe('createRequestIdFactory', () => {
  test('produces unique ids with the default prefix and monotonic core', () => {
    const factory = createRequestIdFactory();
    const first = factory();
    const second = factory();
    expect(first).toMatch(/^req_1_[0-9a-z]{1,6}$/);
    expect(second).toMatch(/^req_2_[0-9a-z]{1,6}$/);
    expect(first).not.toBe(second);
  });

  test('honors a custom prefix', () => {
    const factory = createRequestIdFactory('perm');
    expect(factory()).toMatch(/^perm_1_/);
  });

  test('emits no duplicates across many calls', () => {
    const factory = createRequestIdFactory();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(factory());
    expect(seen.size).toBe(1000);
  });
});
