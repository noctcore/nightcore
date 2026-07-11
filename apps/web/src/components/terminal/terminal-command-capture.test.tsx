import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  IDLE_DEBOUNCE_MS,
  isSkiplistedCommand,
  lockSessionTitle,
  recordCommandInput,
  setAiNamingEnabled,
  setTitleSuggester,
  subscribeTitleSuggestions,
} from './terminal-command-capture';

/** Install a suggester that records the commands it was asked about and returns a
 *  fixed title, plus a subscriber that records applied (id, title) pairs. */
function harness(title: string | null = 'build web') {
  const asked: string[] = [];
  const applied: Array<[string, string]> = [];
  setTitleSuggester(async (_id, command) => {
    asked.push(command);
    return title;
  });
  const unsub = subscribeTitleSuggestions((id, t) => applied.push([id, t]));
  return { asked, applied, unsub };
}

/** Type `line` followed by Enter into a session's capture. */
function runCommand(id: string, line: string) {
  recordCommandInput(id, `${line}\r`);
}

beforeEach(() => {
  vi.useFakeTimers();
  setAiNamingEnabled(true);
});

afterEach(() => {
  setAiNamingEnabled(false); // clears all pending captures/timers
  setTitleSuggester(null);
  vi.useRealTimers();
});

describe('isSkiplistedCommand', () => {
  test('skips navigation / trivial commands (case-insensitive first token)', () => {
    for (const cmd of ['cd', 'ls -la', 'GIT status', 'clear', 'pwd', 'vim x', 'exit']) {
      expect(isSkiplistedCommand(cmd)).toBe(true);
    }
  });

  test('skips empty / whitespace / bare-path lines', () => {
    expect(isSkiplistedCommand('')).toBe(true);
    expect(isSkiplistedCommand('   ')).toBe(true);
    expect(isSkiplistedCommand('/usr/local/bin')).toBe(true);
    expect(isSkiplistedCommand('./scripts')).toBe(true);
    expect(isSkiplistedCommand('~/dev')).toBe(true);
  });

  test('keeps real commands worth naming', () => {
    for (const cmd of ['npm run build', 'cargo test', 'make deploy', 'pnpm dev']) {
      expect(isSkiplistedCommand(cmd)).toBe(false);
    }
  });
});

describe('recordCommandInput debounce + suggestion', () => {
  test('a non-trivial command triggers one suggestion after the idle debounce', async () => {
    const { asked, applied, unsub } = harness();
    runCommand('s1', 'npm run build');
    // Nothing fires until the idle window elapses.
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual(['npm run build']);
    expect(applied).toEqual([['s1', 'build web']]);
    unsub();
  });

  test('further typing resets the idle window (debounce)', async () => {
    const { asked, unsub } = harness();
    runCommand('s2', 'cargo test');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS - 200);
    recordCommandInput('s2', 'x'); // more typing resets the timer
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS - 200);
    expect(asked).toEqual([]); // not yet — the window restarted
    await vi.advanceTimersByTimeAsync(300);
    expect(asked).toEqual(['cargo test']);
    unsub();
  });

  test('once per idle period: an identical command does not re-suggest', async () => {
    const { asked, unsub } = harness();
    runCommand('s3', 'npm run build');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    runCommand('s3', 'npm run build'); // same command again
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual(['npm run build']); // only once
    // A DIFFERENT non-trivial command is allowed to suggest again.
    runCommand('s3', 'cargo test');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual(['npm run build', 'cargo test']);
    unsub();
  });

  test('a skiplisted command never triggers naming', async () => {
    const { asked, unsub } = harness();
    runCommand('s4', 'ls -la');
    runCommand('s4', 'cd packages');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual([]);
    unsub();
  });

  test('a null suggestion is not applied (fail-soft)', async () => {
    const { applied, unsub } = harness(null);
    runCommand('s5', 'make build');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(applied).toEqual([]);
    unsub();
  });
});

describe('gating', () => {
  test('disabled: no capture, no suggestion', async () => {
    setAiNamingEnabled(false);
    const { asked, unsub } = harness();
    runCommand('s6', 'npm run build');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual([]);
    unsub();
  });

  test('a locked (manual/task) session is never captured', async () => {
    const { asked, unsub } = harness();
    lockSessionTitle('s7');
    runCommand('s7', 'npm run build');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual([]);
    unsub();
  });

  test('a manual rename during the idle wait cancels a pending suggestion', async () => {
    const { asked, unsub } = harness();
    runCommand('s8', 'npm run build');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS - 100);
    lockSessionTitle('s8'); // the user renamed it before the debounce elapsed
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual([]);
    unsub();
  });
});

describe('line reconstruction from raw keystrokes', () => {
  test('backspace edits the captured line', async () => {
    const { asked, unsub } = harness();
    recordCommandInput('s9', 'npmm'); // typo
    recordCommandInput('s9', '\x7f'); // backspace
    recordCommandInput('s9', ' run build\r');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual(['npm run build']);
    unsub();
  });

  test('escape / arrow sequences are ignored (best-effort capture)', async () => {
    const { asked, unsub } = harness();
    // "make" + left-arrow (\x1b[D) + " test" — the CSI sequence is stripped.
    recordCommandInput('s10', 'make\x1b[D test\r');
    await vi.advanceTimersByTimeAsync(IDLE_DEBOUNCE_MS);
    expect(asked).toEqual(['make test']);
    unsub();
  });
});
