import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  loadTranscript,
  parseTranscript,
  restampSessionId,
  transcriptNameFor,
} from './transcript.js';

/** The canonical fixture directory, shared with ring 1(c)'s Rust drivers. Resolved
 *  from this file so the test moves with the tree, and asserted to exist — a silently
 *  wrong path would make every "the real fixtures load" test below vacuous. */
const FIXTURES = path.resolve(
  import.meta.dir,
  '../../../../../apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-replay-'));
}

const READY = JSON.stringify({
  type: 'session-ready',
  sessionId: 7,
  sdkSessionId: 'c0ffee00-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  model: 'claude-opus-4-8',
  tools: [],
  slashCommands: [],
  skills: [],
});
const COMPLETED = JSON.stringify({
  type: 'session-completed',
  sessionId: 7,
  result: 'done',
  numTurns: 1,
  durationMs: 1,
});

describe('transcriptNameFor', () => {
  test('honors a `#replay <name>` directive on the prompt’s first line', () => {
    expect(
      transcriptNameFor({ prompt: '#replay build-failed\nignored body' }),
    ).toBe('build-failed');
  });

  test('ignores a directive that is not on the first line', () => {
    expect(transcriptNameFor({ prompt: 'do a thing\n#replay build-failed' })).toBe(
      'build',
    );
  });

  test('falls back to the build transcript for an ordinary prompt', () => {
    expect(transcriptNameFor({ prompt: 'fix the bug', kind: 'build' })).toBe('build');
    expect(transcriptNameFor({ prompt: 'research it', kind: 'research' })).toBe(
      'build',
    );
  });
});

describe('parseTranscript', () => {
  test('parses wire lines in order and skips blank ones', () => {
    const events = parseTranscript('t', `${READY}\n\n${COMPLETED}\n`);
    expect(events.map((e) => e.type)).toEqual([
      'session-ready',
      'session-completed',
    ]);
  });

  test('throws on a line that is not JSON, naming the line number', () => {
    expect(() => parseTranscript('t', `${READY}\nnot json\n${COMPLETED}`)).toThrow(
      /line 2 is not valid JSON/,
    );
  });

  test('throws on a line that is not a contract-valid NightcoreEvent', () => {
    // Shape drift is the failure mode that would otherwise be SILENT: the sidecar's
    // outbound validator would drop the line and the ring would assert against a
    // stream that is quietly missing events.
    const bad = JSON.stringify({ type: 'session-ready', sessionId: 'seven' });
    expect(() => parseTranscript('t', `${bad}\n${COMPLETED}`)).toThrow(
      /line 1 is not a valid NightcoreEvent/,
    );
  });

  test('throws on an empty transcript rather than replaying nothing', () => {
    expect(() => parseTranscript('t', '\n\n  \n')).toThrow(/is empty/);
  });

  test('throws when the transcript never reaches a terminal event', () => {
    expect(() => parseTranscript('t', READY)).toThrow(/would never settle/);
  });
});

describe('loadTranscript', () => {
  test('reads the named fixture from the directory', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'demo.jsonl'), `${READY}\n${COMPLETED}\n`);
    expect(loadTranscript(dir, 'demo').map((e) => e.type)).toEqual([
      'session-ready',
      'session-completed',
    ]);
  });

  test('throws (naming the resolved path) when the transcript is missing', () => {
    const dir = tempDir();
    expect(() => loadTranscript(dir, 'nope')).toThrow(/not found at .*nope\.jsonl/);
  });

  test('rejects a name that could escape the transcript directory', () => {
    const dir = tempDir();
    for (const name of ['../secrets', 'a/b', '..', '/etc/passwd']) {
      expect(() => loadTranscript(dir, name)).toThrow(/invalid replay transcript name/);
    }
  });

  test('loads the REAL checked-in ladder fixtures', () => {
    // The grounding test: rings 2-3 replay these exact files, so a fixture that stops
    // satisfying the contract must fail here, not in a CI job three layers up.
    expect(fs.existsSync(FIXTURES)).toBe(true);
    const build = loadTranscript(FIXTURES, 'build');
    expect(build.at(0)?.type).toBe('session-ready');
    expect(build.at(-1)?.type).toBe('session-completed');
    const failed = loadTranscript(FIXTURES, 'build-failed');
    expect(failed.at(-1)?.type).toBe('session-failed');
  });
});

describe('restampSessionId', () => {
  test('rewrites the recorded session id onto the live one', () => {
    const [ready] = parseTranscript('t', `${READY}\n${COMPLETED}`);
    expect(restampSessionId(ready!, 42)).toMatchObject({
      type: 'session-ready',
      sessionId: 42,
    });
  });

  test('leaves an event without a sessionId untouched', () => {
    const queryResult = {
      type: 'query-result' as const,
      requestId: 'r1',
      ok: true,
      kind: 'ack' as const,
    };
    // Structural: no sessionId key is invented on an event that never had one.
    expect('sessionId' in restampSessionId(queryResult, 42)).toBe(false);
  });
});
