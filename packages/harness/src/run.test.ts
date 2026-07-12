import { describe, expect, test } from 'bun:test';

import type { PlannedCheck } from './manifest.js';
import {
  emptyPass,
  fixInstruction,
  runChecks,
  type SpawnFn,
  type SpawnResult,
  tailOutput,
} from './run.js';

const RUN_DIR = '/run';

function check(name: string, command = `cmd-${name}`): PlannedCheck {
  const [program, ...args] = command.split(/\s+/);
  return { name, kind: 'lint-plugin', command, program: program ?? '', args, timeoutMs: 1000 };
}

function ok(): SpawnResult {
  return { status: 0, signal: null, stdout: '', stderr: '' };
}
function fail(exit = 1, stdout = 'boom', stderr = ''): SpawnResult {
  return { status: exit, signal: null, stdout, stderr };
}

describe('runChecks (full-run, mirrors runner.rs FULL-RUN semantics)', () => {
  test('a single passing check ⇒ passed, exit 0-shaped result', () => {
    const result = runChecks([check('a')], RUN_DIR, () => ok());
    expect(result.passed).toBe(true);
    expect(result.failedCheck).toBeUndefined();
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe('passed');
    expect(result.checks[0]?.exitCode).toBe(0);
  });

  test('a failing check ⇒ not passed, captures the output tail', () => {
    const result = runChecks([check('a')], RUN_DIR, () => fail(3, 'stdout-body', 'stderr-body'));
    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('a');
    expect(result.checks[0]?.status).toBe('failed');
    expect(result.checks[0]?.exitCode).toBe(3);
    expect(result.checks[0]?.output).toBe('stdout-body\nstderr-body');
  });

  test('FULL-RUN: when the first check fails the second STILL runs and both report', () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (program) => {
      calls.push(program);
      return fail();
    };
    const result = runChecks([check('first', 'a'), check('second', 'b')], RUN_DIR, spawn);
    // Both spawned (the old stop-at-first would have run only the first).
    expect(calls).toEqual(['a', 'b']);
    expect(result.checks.map((c) => c.status)).toEqual(['failed', 'failed']);
    // failedCheck is the FIRST failure (back-compat).
    expect(result.failedCheck).toBe('first');
    expect(result.passed).toBe(false);
  });

  test('a mixed run passes iff no check failed', () => {
    const spawn: SpawnFn = (program) => (program === 'bad' ? fail() : ok());
    const result = runChecks(
      [check('a', 'good'), check('b', 'bad'), check('c', 'good')],
      RUN_DIR,
      spawn,
    );
    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('b');
    expect(result.checks.map((c) => c.status)).toEqual(['passed', 'failed', 'passed']);
  });

  test('a timeout (ETIMEDOUT) is a FAILED check, never a silent pass', () => {
    const spawn: SpawnFn = () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT', message: 'timed out' },
    });
    const result = runChecks([check('slow')], RUN_DIR, spawn);
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.status).toBe('failed');
    expect(result.checks[0]?.output).toContain('timed out after 1000ms');
  });

  test('a signal kill without an error object is treated as a timeout failure', () => {
    const spawn: SpawnFn = () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' });
    const result = runChecks([check('killed')], RUN_DIR, spawn);
    expect(result.checks[0]?.status).toBe('failed');
    expect(result.checks[0]?.output).toContain('timed out after');
  });

  test('a launch failure (missing program) is a FAILED check', () => {
    const spawn: SpawnFn = () => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: { code: 'ENOENT', message: 'spawn nope ENOENT' },
    });
    const result = runChecks([check('missing')], RUN_DIR, spawn);
    expect(result.checks[0]?.status).toBe('failed');
    expect(result.checks[0]?.output).toContain('failed to launch');
  });

  test('records a duration for every check', () => {
    const result = runChecks([check('a')], RUN_DIR, () => ok());
    expect(typeof result.checks[0]?.durationMs).toBe('number');
  });

  test('no planned checks ⇒ trivially passing', () => {
    expect(runChecks([], RUN_DIR, () => ok())).toEqual(emptyPass());
    expect(emptyPass()).toEqual({ passed: true, checks: [] });
  });
});

describe('tailOutput (mirrors tail_output)', () => {
  test('combines stdout + stderr with a newline', () => {
    expect(tailOutput('out', 'err')).toBe('out\nerr');
    expect(tailOutput('out', '')).toBe('out');
  });

  test('truncates from the tail with a leading ellipsis', () => {
    const big = 'x'.repeat(5000);
    const out = tailOutput(big, '');
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBe(4001);
  });
});

describe('fixInstruction (mirrors fix_instruction)', () => {
  test('lists EVERY failed check with its command and output', () => {
    const result = runChecks(
      [check('one', 'cmd-one'), check('two', 'cmd-two')],
      RUN_DIR,
      () => fail(1, 'the failure body'),
    );
    const msg = fixInstruction(result);
    expect(msg).toContain('2 project harness checks did not pass');
    expect(msg).toContain('`one`');
    expect(msg).toContain('`two`');
    expect(msg).toContain('Command: cmd-one');
    expect(msg).toContain('the failure body');
  });

  test('degrades to a generic message when nothing failed', () => {
    expect(fixInstruction(emptyPass())).toContain('The Structure-Lock check failed');
  });

  test('singularizes the count for one failure', () => {
    const result = runChecks([check('solo')], RUN_DIR, () => fail());
    expect(fixInstruction(result)).toContain('1 project harness check did not pass');
  });
});
