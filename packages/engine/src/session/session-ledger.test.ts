/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { Logger } from '@nightcore/shared';

import {
  DIGEST_MAX_CHARS,
  digestToolInput,
  SessionLedger,
} from './session-ledger.js';

function fakeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ledger-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Parse every NDJSON line of the ledger file. */
function readRecords(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('digestToolInput', () => {
  test('picks the Bash command line', () => {
    expect(digestToolInput({ command: 'git commit --no-verify', timeout: 5 })).toBe(
      'git commit --no-verify',
    );
  });

  test('picks the mutation target path for file tools', () => {
    expect(digestToolInput({ file_path: 'migrations/0001.sql', content: 'x' })).toBe(
      'migrations/0001.sql',
    );
    expect(digestToolInput({ notebook_path: 'nb.ipynb' })).toBe('nb.ipynb');
    expect(digestToolInput({ path: 'src/', pattern: 'foo' })).toBe('src/');
  });

  test('truncates to the digest budget', () => {
    const digest = digestToolInput({ command: 'x'.repeat(DIGEST_MAX_CHARS + 50) });
    expect(digest).toHaveLength(DIGEST_MAX_CHARS);
  });

  test('falls back to JSON for unknown shapes and stringifies scalars', () => {
    expect(digestToolInput({ other: 1 })).toBe('{"other":1}');
    expect(digestToolInput('raw')).toBe('raw');
    expect(digestToolInput(undefined)).toBe('');
    expect(digestToolInput(null)).toBe('');
  });
});

describe('SessionLedger — appends', () => {
  test('creates parent dirs lazily and appends one parseable NDJSON record per decision', () => {
    const file = path.join(tmp, 'nested', 'ledger', 'task-1.ndjson');
    const ledger = new SessionLedger(file);

    ledger.recordSessionStart(7);
    ledger.recordToolDecision('Bash', { command: 'bun test' }, 'allow');
    ledger.recordToolDecision(
      'Write',
      { file_path: 'migrations/0001.sql' },
      'deny',
      'harness-protected-path',
    );
    ledger.recordSessionEnd(7);

    const records = readRecords(file);
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ event: 'session-start', sessionId: 7 });
    expect(records[1]).toMatchObject({
      tool: 'Bash',
      inputDigest: 'bun test',
      decision: 'allow',
    });
    expect(records[1]!['ruleId']).toBeUndefined();
    expect(records[2]).toMatchObject({
      tool: 'Write',
      inputDigest: 'migrations/0001.sql',
      decision: 'deny',
      ruleId: 'harness-protected-path',
    });
    expect(records[3]).toMatchObject({ event: 'session-end', sessionId: 7 });
    // Every record carries an ISO timestamp.
    for (const record of records) {
      expect(Date.parse(record['ts'] as string)).toBeGreaterThan(0);
    }
  });

  test('appends to an existing file (sessions of one task share the ledger)', () => {
    const file = path.join(tmp, 'task-2.ndjson');
    const first = new SessionLedger(file);
    first.recordSessionStart(1);
    first.recordSessionEnd(1);

    const second = new SessionLedger(file);
    second.recordSessionStart(2);

    const records = readRecords(file);
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ event: 'session-start', sessionId: 2 });
  });
});

describe('SessionLedger — size cap', () => {
  test('crossing the cap writes ONE final truncated marker and stops recording', () => {
    const file = path.join(tmp, 'capped.ndjson');
    const logger = fakeLogger();
    // ~3 records of this shape fit in 300 bytes; the rest must be dropped.
    const ledger = new SessionLedger(file, logger, 300);

    for (let i = 0; i < 20; i += 1) {
      ledger.recordToolDecision('Bash', { command: `echo ${i}` }, 'allow');
    }

    const records = readRecords(file);
    const truncated = records.filter((r) => r['event'] === 'truncated');
    expect(truncated).toHaveLength(1);
    expect(records[records.length - 1]!['event']).toBe('truncated');
    expect(records.length).toBeLessThan(20);
    // The cap is a bound on the FILE, marker included (~with one line of slack).
    expect(fs.statSync(file).size).toBeLessThan(300 + 120);
  });

  test('a new writer over an already-capped file stays silent (no second marker)', () => {
    const file = path.join(tmp, 'capped-twice.ndjson');
    const first = new SessionLedger(file, undefined, 200);
    for (let i = 0; i < 10; i += 1) {
      first.recordToolDecision('Bash', { command: `echo ${i}` }, 'allow');
    }
    const sizeAfterFirst = fs.statSync(file).size;

    const second = new SessionLedger(file, undefined, 200);
    second.recordSessionStart(3);
    second.recordToolDecision('Bash', { command: 'echo more' }, 'allow');

    expect(fs.statSync(file).size).toBe(sizeAfterFirst);
    const truncated = readRecords(file).filter((r) => r['event'] === 'truncated');
    expect(truncated).toHaveLength(1);
  });
});

describe('SessionLedger — fail-open', () => {
  test('a write error never throws, warns once, and drops later records silently', () => {
    // The parent "dir" is a FILE, so mkdir/append must fail.
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const logger = fakeLogger();
    const ledger = new SessionLedger(path.join(blocker, 'task.ndjson'), logger);

    expect(() => {
      ledger.recordSessionStart(1);
      ledger.recordToolDecision('Bash', { command: 'echo hi' }, 'allow');
      ledger.recordSessionEnd(1);
    }).not.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
