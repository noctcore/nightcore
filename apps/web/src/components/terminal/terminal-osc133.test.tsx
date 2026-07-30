import { afterEach, describe, expect, test } from 'vitest';

import {
  adjacentPromptLine,
  applyOsc133ForTest,
  type CommandBlock,
  commandBlocks,
  forgetOsc133,
  lastOutputBlock,
  parseOsc133,
  resetOsc133ForTest,
  SLOW_COMMAND_MS,
} from './terminal-osc133';

afterEach(() => resetOsc133ForTest());

/** A completed block at `promptLine`, output one line below. */
function block(promptLine: number, over: Partial<CommandBlock> = {}): CommandBlock {
  return {
    promptLine,
    outputLine: promptLine + 1,
    endLine: promptLine + 3,
    exitCode: 0,
    startedAt: 0,
    durationMs: 10,
    ...over,
  };
}

describe('parseOsc133', () => {
  test('reads the four marks', () => {
    for (const mark of ['A', 'B', 'C', 'D']) {
      expect(parseOsc133(mark)?.mark).toBe(mark);
    }
  });

  test('reads an exit code off D', () => {
    expect(parseOsc133('D;0')).toEqual({ mark: 'D', exitCode: 0 });
    expect(parseOsc133('D;127')).toEqual({ mark: 'D', exitCode: 127 });
  });

  test('D with a non-numeric field is "finished, status unknown" — never a fake 0', () => {
    // Real shells append `;aid=…` / `;cl=…` params. Reading those as an exit code would
    // paint a green "exited 0" bar for a command that may well have failed.
    expect(parseOsc133('D;aid=17')).toEqual({ mark: 'D', exitCode: null });
    expect(parseOsc133('D')).toEqual({ mark: 'D', exitCode: null });
  });

  test('tolerates extra parameters on the other marks', () => {
    expect(parseOsc133('A;cl=m;aid=3')?.mark).toBe('A');
    expect(parseOsc133('C;special=1')?.mark).toBe('C');
  });

  test('returns null for a payload it does not model', () => {
    expect(parseOsc133('P;Cwd=/x')).toBeNull(); // the ConEmu-style sub-mark
    expect(parseOsc133('')).toBeNull();
    expect(parseOsc133('nonsense')).toBeNull();
  });
});

describe('command blocks', () => {
  test('A→C→D assembles one block with its exit code and duration', () => {
    applyOsc133ForTest('s', 'A', 10, 1_000);
    applyOsc133ForTest('s', 'B', 10, 1_000);
    applyOsc133ForTest('s', 'C', 11, 1_000);
    applyOsc133ForTest('s', 'D;0', 20, 3_500);

    const [only] = commandBlocks('s');
    expect(only).toMatchObject({
      promptLine: 10,
      outputLine: 11,
      endLine: 20,
      exitCode: 0,
      durationMs: 2_500,
    });
  });

  test('a non-zero exit is recorded as itself, not coerced', () => {
    applyOsc133ForTest('s', 'A', 0);
    applyOsc133ForTest('s', 'C', 1);
    applyOsc133ForTest('s', 'D;127', 2);
    expect(commandBlocks('s')[0]?.exitCode).toBe(127);
  });

  test('a prompt the user never ran anything at stays exit-code-unknown', () => {
    // Bare Enter at a prompt: A then A, with no C in between. The first block must not
    // inherit the second command's status.
    applyOsc133ForTest('s', 'A', 0);
    applyOsc133ForTest('s', 'A', 1);
    applyOsc133ForTest('s', 'C', 2);
    applyOsc133ForTest('s', 'D;0', 3);

    const blocks = commandBlocks('s');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.exitCode).toBeNull();
    expect(blocks[0]?.outputLine).toBeNull();
    expect(blocks[1]?.exitCode).toBe(0);
  });

  test('a running command has no end line until D lands', () => {
    applyOsc133ForTest('s', 'A', 0);
    applyOsc133ForTest('s', 'C', 1);
    expect(commandBlocks('s')[0]?.endLine).toBeNull();
    expect(lastOutputBlock('s')).toBeNull(); // nothing FINISHED to copy yet
  });

  test('blocks are per session', () => {
    applyOsc133ForTest('a', 'A', 0);
    applyOsc133ForTest('b', 'A', 0);
    applyOsc133ForTest('b', 'A', 5);
    expect(commandBlocks('a')).toHaveLength(1);
    expect(commandBlocks('b')).toHaveLength(2);
  });

  test('forgetting a session drops its blocks', () => {
    applyOsc133ForTest('s', 'A', 0);
    forgetOsc133('s');
    expect(commandBlocks('s')).toEqual([]);
  });

  test('a shell that emits nothing simply has no blocks', () => {
    // The degrade-to-today path: every read accessor is empty/null, and the nav + copy
    // actions built on them become inert no-ops.
    expect(commandBlocks('silent')).toEqual([]);
    expect(lastOutputBlock('silent')).toBeNull();
    expect(adjacentPromptLine(commandBlocks('silent'), 0, -1)).toBeNull();
  });
});

describe('prompt navigation', () => {
  const blocks = [block(10), block(30), block(50)];

  test('finds the previous prompt strictly above the viewport', () => {
    expect(adjacentPromptLine(blocks, 40, -1)).toBe(30);
    expect(adjacentPromptLine(blocks, 30, -1)).toBe(10);
  });

  test('finds the next prompt strictly below the viewport', () => {
    expect(adjacentPromptLine(blocks, 10, 1)).toBe(30);
    expect(adjacentPromptLine(blocks, 31, 1)).toBe(50);
  });

  test('returns null at the ends rather than snapping to an edge', () => {
    // A no-op is honest here: snapping to the first/last prompt would silently move the
    // viewport when the user asked for something that does not exist.
    expect(adjacentPromptLine(blocks, 10, -1)).toBeNull();
    expect(adjacentPromptLine(blocks, 50, 1)).toBeNull();
    expect(adjacentPromptLine([], 0, -1)).toBeNull();
  });
});

describe('copy-last-output target', () => {
  test('picks the most recent FINISHED block, not a running one', () => {
    applyOsc133ForTest('s', 'A', 0);
    applyOsc133ForTest('s', 'C', 1);
    applyOsc133ForTest('s', 'D;0', 5);
    applyOsc133ForTest('s', 'A', 6); // a new prompt
    applyOsc133ForTest('s', 'C', 7); // …with a command still running

    // ⌘⇧O mid-build copies the previous RESULT, not a half-written stream.
    expect(lastOutputBlock('s')?.promptLine).toBe(0);
  });

  test('skips a block that produced no output at all', () => {
    applyOsc133ForTest('s', 'A', 0);
    applyOsc133ForTest('s', 'C', 1);
    applyOsc133ForTest('s', 'D;0', 4);
    applyOsc133ForTest('s', 'A', 5);
    applyOsc133ForTest('s', 'D;0', 5); // bare Enter — never ran, no output span
    expect(lastOutputBlock('s')?.promptLine).toBe(0);
  });
});

describe('slow-command threshold', () => {
  test('the >5s notify threshold is 5 seconds', () => {
    // Pinned: the issue specifies "notify if >5s", and the value is load-bearing for
    // whether a backgrounded build actually pings the user.
    expect(SLOW_COMMAND_MS).toBe(5_000);
  });

  test('duration is measured from C to D, not from the prompt', () => {
    // A user can sit at a prompt for minutes before pressing Enter; timing from A would
    // notify for a command that took no time at all.
    applyOsc133ForTest('s', 'A', 0, 0);
    applyOsc133ForTest('s', 'C', 1, 60_000);
    applyOsc133ForTest('s', 'D;0', 2, 60_100);
    expect(commandBlocks('s')[0]?.durationMs).toBe(100);
  });
});
