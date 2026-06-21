/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
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
  test('keeps the <ISO> <LEVEL> [scope] <msg> <json> shape', () => {
    setTTY(false);
    const [line] = captureStderr(() => {
      createLogger('info', 'core').info('hello', { a: 1 });
    });
    expect(line).toMatch(
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
    // The LEVEL token is the bare uppercase word.
    expect(lines[0]).toContain(' ERROR [core] e');
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
