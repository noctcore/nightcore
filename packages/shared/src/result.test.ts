/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { err, ok, tryCatch, tryCatchAsync } from './result.js';

describe('ok / err constructors', () => {
  test('ok wraps a value with ok: true', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  test('err wraps an error with ok: false', () => {
    const error = new Error('boom');
    const r = err(error);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });
});

describe('tryCatch', () => {
  test('captures a successful return as ok', () => {
    const r = tryCatch(() => 1 + 1);
    expect(r).toEqual({ ok: true, value: 2 });
  });

  test('captures a thrown Error as err without rethrowing', () => {
    const r = tryCatch(() => {
      throw new Error('nope');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe('nope');
    }
  });

  test('wraps a non-Error throw into an Error', () => {
    const r = tryCatch(() => {
      throw 'string failure';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe('string failure');
    }
  });
});

describe('tryCatchAsync', () => {
  test('captures a resolved value as ok', async () => {
    const r = await tryCatchAsync(async () => 'done');
    expect(r).toEqual({ ok: true, value: 'done' });
  });

  test('captures a rejection as err without rejecting', async () => {
    const r = await tryCatchAsync(async () => {
      throw new Error('async boom');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('async boom');
  });

  test('wraps a non-Error rejection into an Error', async () => {
    const r = await tryCatchAsync(async () => {
      throw 123;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.error.message).toBe('123');
    }
  });
});
