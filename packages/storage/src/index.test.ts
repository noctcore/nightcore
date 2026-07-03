/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { SessionRecord } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { SessionStore } from './index.js';

let dir: string;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 1,
    prompt: 'hello',
    model: 'claude-opus-4-8',
    permissionMode: 'default',
    cwd: '/work',
    status: 'running',
    createdAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-storage-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore.save / list / get', () => {
  test('persists and reads back a single record', () => {
    const store = new SessionStore(dir);
    const rec = record();
    store.save(rec);
    expect(store.list()).toEqual([rec]);
    expect(store.get(1)).toEqual(rec);
  });

  test('creates the storage directory lazily on first save', () => {
    const nested = path.join(dir, 'a', 'b', 'sessions');
    const store = new SessionStore(nested);
    store.save(record());
    expect(fs.existsSync(path.join(nested, 'index.jsonl'))).toBe(true);
  });

  test('collapses duplicate ids with last-write-wins', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1, status: 'running' }));
    store.save(record({ id: 1, status: 'completed', costUsd: 0.5 }));
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('completed');
    expect(list[0]?.costUsd).toBe(0.5);
  });

  test('sorts list newest-first by createdAt', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1, createdAt: 100 }));
    store.save(record({ id: 2, createdAt: 300 }));
    store.save(record({ id: 3, createdAt: 200 }));
    expect(store.list().map((r) => r.id)).toEqual([2, 3, 1]);
  });
});

/** A Logger stub that records every warn call, for the read-error tests. */
function recordingLogger(): { warns: unknown[][]; logger: Logger } {
  const warns: unknown[][] = [];
  const logger: Logger = {
    error: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return { warns, logger };
}

describe('SessionStore resilience', () => {
  test('returns an empty list when no file exists', () => {
    const store = new SessionStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.get(99)).toBeUndefined();
  });

  test('a missing file is NOT logged as an error (silent cold start)', () => {
    const { warns, logger } = recordingLogger();
    const store = new SessionStore(dir, logger);
    expect(store.list()).toEqual([]);
    expect(warns).toEqual([]);
  });

  test('a real read error (not ENOENT) is logged at warn, not swallowed', () => {
    const { warns, logger } = recordingLogger();
    const store = new SessionStore(dir, logger);
    // Force a non-ENOENT failure: put a DIRECTORY where the index file goes, so
    // readFileSync throws EISDIR. Pre-fix this was indistinguishable from a cold
    // start and silently returned []; post-fix it must warn.
    fs.mkdirSync(path.join(dir, 'index.jsonl'), { recursive: true });
    expect(store.list()).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(String(warns[0]?.[0])).toContain('failed to read session store');
  });

  test('reflects fresh data after an append (cache is invalidated on save)', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1, status: 'running' }));
    // Warm the cache.
    expect(store.list().map((r) => r.id)).toEqual([1]);
    expect(store.get(1)?.status).toBe('running');
    // A subsequent save must be visible to both list() and get().
    store.save(record({ id: 1, status: 'completed', costUsd: 0.5 }));
    store.save(record({ id: 2, createdAt: 2000 }));
    expect(store.list().map((r) => r.id)).toEqual([2, 1]);
    expect(store.get(1)?.status).toBe('completed');
    expect(store.get(2)).toBeDefined();
  });

  test('memoizes the parsed result when the file has not changed (cache hit)', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1 }));
    const first = store.list();
    // With no intervening save, repeated reads return the SAME array instance —
    // the file is not re-parsed. A save() below breaks the identity, proving the
    // memoization is invalidated rather than permanently frozen.
    expect(store.list()).toBe(first);
    expect(store.get(1)?.id).toBe(1);
    store.save(record({ id: 2, createdAt: 2000 }));
    expect(store.list()).not.toBe(first);
    expect(store.list()).toBe(store.list());
  });

  test('picks up an external edit to the file (stat-based invalidation)', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1 }));
    expect(store.list().map((r) => r.id)).toEqual([1]);
    // Simulate another writer appending directly, bypassing save().
    const file = path.join(dir, 'index.jsonl');
    fs.appendFileSync(
      file,
      `${JSON.stringify(record({ id: 2, createdAt: 2000 }))}\n`,
      'utf8',
    );
    expect(store.list().map((r) => r.id)).toEqual([2, 1]);
    expect(store.get(2)).toBeDefined();
  });

  test('skips malformed and invalid lines without throwing', () => {
    const store = new SessionStore(dir);
    store.save(record({ id: 1 }));
    // Inject a garbage line and a structurally-invalid record line.
    const file = path.join(dir, 'index.jsonl');
    fs.appendFileSync(file, 'not json at all\n', 'utf8');
    fs.appendFileSync(file, `${JSON.stringify({ id: 'nope' })}\n`, 'utf8');
    store.save(record({ id: 2 }));
    const list = store.list();
    expect(list.map((r) => r.id).sort()).toEqual([1, 2]);
  });
});
