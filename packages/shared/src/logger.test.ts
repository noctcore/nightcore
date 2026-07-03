/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';

import { LogLevelSchema } from '@nightcore/contracts';

import { createLogger } from './logger.js';

/** Capture every line written to stderr while `fn` runs, restoring the original. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — minimal stub of the write signature for the test.
  process.stderr.write = (chunk: string): boolean => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/** Toggle the TTY flag for the duration of a test, restoring it after. */
const originalIsTTY = process.stderr.isTTY;
afterEach(() => {
  Object.defineProperty(process.stderr, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  });
});
function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
}

const ESC = '\x1b';

describe('createLogger output shape', () => {
  test('captured (non-TTY) shape is <LEVEL> [scope] <msg> <json> — no self-timestamp', () => {
    setTTY(false);
    const [line] = captureStderr(() => {
      createLogger('info', 'core').info('hello', { a: 1 });
    });
    // Rust's tracing sink owns the single timestamp when it drains our stderr; we must
    // NOT self-prepend one (doing so double-stamps every captured line). LEVEL stays first.
    expect(line).toMatch(/^INFO \[core\] hello \{"a":1\}\n$/);
  });

  test('interactive (TTY) shape keeps the full pretty <ISO> <LEVEL> [scope] <msg> <json>', () => {
    setTTY(true);
    const [line] = captureStderr(() => {
      createLogger('info', 'core').info('hello', { a: 1 });
    });
    // Strip ANSI (the LEVEL token is colorized on a TTY) before matching the shape.
    const plain = line.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join('');
    expect(plain).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO \[core\] hello \{"a":1\}\n$/,
    );
  });

  test('child scope is appended', () => {
    setTTY(false);
    const [line] = captureStderr(() => {
      createLogger('info', 'core').child('session').info('hi');
    });
    expect(line).toContain('[core:session]');
  });

  test('respects the level threshold', () => {
    setTTY(false);
    const lines = captureStderr(() => {
      const log = createLogger('warn', 'core');
      log.info('suppressed');
      log.warn('shown');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN');
  });
});

describe('TTY colorization', () => {
  test('non-TTY output is plain (no ANSI), so captured/file logs stay parseable', () => {
    setTTY(false);
    const lines = captureStderr(() => {
      const log = createLogger('debug', 'core');
      log.error('e');
      log.warn('w');
      log.info('i');
      log.debug('d');
    });
    for (const line of lines) {
      expect(line).not.toContain(ESC);
    }
    // Captured shape: the bare uppercase LEVEL token leads (no timestamp before it).
    expect(lines[0]).toMatch(/^ERROR \[core\] e\n$/);
  });

  test('TTY output colorizes the LEVEL token per level', () => {
    setTTY(true);
    const lines = captureStderr(() => {
      const log = createLogger('debug', 'core');
      log.error('e');
      log.warn('w');
      log.info('i');
      log.debug('d');
    });
    // error=red(31), warn=yellow(33), info=cyan(36), debug=dim(2); each resets.
    expect(lines[0]).toContain(`${ESC}[31mERROR${ESC}[0m`);
    expect(lines[1]).toContain(`${ESC}[33mWARN${ESC}[0m`);
    expect(lines[2]).toContain(`${ESC}[36mINFO${ESC}[0m`);
    expect(lines[3]).toContain(`${ESC}[2mDEBUG${ESC}[0m`);
  });

  test('TTY colorization leaves the rest of the line untouched', () => {
    setTTY(true);
    const [line] = captureStderr(() => {
      createLogger('info', 'core').info('msg', { k: 'v' });
    });
    // Strip ANSI (split on the ESC-prefixed SGR sequences) and assert the shape.
    const plain = line.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join('');
    expect(plain).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO \[core\] msg \{"k":"v"\}\n$/,
    );
  });
});

describe('LogLevel single source (@nightcore/contracts is canonical)', () => {
  // `LogLevel` used to be declared twice — a bare union here and the
  // `LogLevelSchema` zod enum in @nightcore/contracts — kept in sync only by
  // coincidence. The type is now imported from contracts, so the two can no
  // longer diverge. This test pins the wiring: every level the contract enum
  // admits is a real, weighted level the shared logger honors. It only compiles
  // because `createLogger`'s parameter type IS the contracts `LogLevel`; if the
  // contract enum diverged, the logger's `Record<LogLevel, …>` weight table would
  // fail to compile before this ever ran.
  test('createLogger honors every level in the contracts LogLevel enum', () => {
    setTTY(false);
    for (const level of LogLevelSchema.options) {
      const lines = captureStderr(() => createLogger(level, 'core').error('x'));
      if (level === 'silent') {
        expect(lines).toHaveLength(0); // 'silent' suppresses even error
      } else {
        expect(lines[0]).toContain('ERROR'); // every other level admits error
      }
    }
    // Pin the canonical set so an accidental enum edit trips a review here too.
    expect([...LogLevelSchema.options].sort()).toEqual([
      'debug',
      'error',
      'info',
      'silent',
      'warn',
    ]);
  });
});

describe('captured-mode wire contract (Rust owns the timestamp + level)', () => {
  // Pins the doubled-log regression: when the Rust core captures our stderr (non-TTY)
  // we must NOT self-prepend an ISO timestamp, but MUST keep the LEVEL token first so
  // the Rust `sidecar_level` parser reads it as field 0. See
  // apps/desktop/src-tauri/src/sidecar/mod.rs (`sidecar_level` / `strip_level_token`).
  test('piped output drops the self-timestamp, keeps LEVEL first + child scope', () => {
    setTTY(false); // captured by the Rust core
    const [line] = captureStderr(() => {
      createLogger('info', 'sidecar')
        .child('harness')
        .info('[harness:design-decisions] turn 7 · Glob');
    });
    // The duplicated half was the leading ISO-8601 timestamp — post-fix it is gone.
    expect(line).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // LEVEL token stays FIRST so the Rust side recovers the level from field 0.
    expect(line.trimStart()).toMatch(/^INFO\b/);
    // The child scope (which Rust's flat `target: "sidecar"` loses) is preserved.
    expect(line).toContain('[sidecar:harness]');
    // The message body survives intact.
    expect(line).toContain('[harness:design-decisions] turn 7 · Glob');
  });
});
