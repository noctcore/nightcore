import { describe, expect, it } from 'vitest';

import type { RunOrderEntry, RunOrderProjection } from '@/lib/bridge';

import { armPreview, EMPTY_RUN_ORDER, nextUp, runOrderIndex } from './run-order';

function entry(overrides: Partial<RunOrderEntry> = {}): RunOrderEntry {
  return {
    taskId: overrides.taskId ?? 't-1',
    position: overrides.position ?? 1,
    wave: overrides.wave ?? 0,
    startsNow: overrides.startsNow ?? true,
    blockedBy: overrides.blockedBy ?? [],
  };
}

function projection(overrides: Partial<RunOrderProjection> = {}): RunOrderProjection {
  return { ...EMPTY_RUN_ORDER, ...overrides };
}

describe('runOrderIndex', () => {
  it('indexes entries by task id so a card can look up its own position', () => {
    const index = runOrderIndex(
      projection({
        entries: [
          entry({ taskId: 'a', position: 1 }),
          entry({ taskId: 'b', position: 2, wave: 1, startsNow: false }),
        ],
      }),
    );
    expect(index.get('a')?.position).toBe(1);
    expect(index.get('b')?.startsNow).toBe(false);
    expect(index.get('missing')).toBeUndefined();
  });

  it('is empty for the empty projection', () => {
    expect(runOrderIndex(EMPTY_RUN_ORDER).size).toBe(0);
  });
});

describe('nextUp', () => {
  it('takes the head of the already-ordered entries (never re-sorts)', () => {
    const p = projection({
      entries: [
        entry({ taskId: 'a', position: 1 }),
        entry({ taskId: 'b', position: 2 }),
        entry({ taskId: 'c', position: 3 }),
      ],
    });
    expect(nextUp(p, 2).map((e) => e.taskId)).toEqual(['a', 'b']);
    expect(nextUp(p, 99).map((e) => e.taskId)).toEqual(['a', 'b', 'c']);
    expect(nextUp(p, 0)).toEqual([]);
    expect(nextUp(p, -3)).toEqual([]);
  });
});

describe('armPreview', () => {
  it('reports an idle board with nothing to launch', () => {
    const preview = armPreview(EMPTY_RUN_ORDER);
    expect(preview).toMatchObject({ startsNow: 0, queued: 0, stuck: 0, idle: true });
    expect(preview.summary).toBe('Nothing queued to run');
  });

  it('answers "this will start N tasks" before arming', () => {
    const preview = armPreview(
      projection({
        entries: [
          entry({ taskId: 'a', position: 1 }),
          entry({ taskId: 'b', position: 2 }),
          entry({ taskId: 'c', position: 3, wave: 1, startsNow: false }),
        ],
        startsNowCount: 2,
        freeSlots: 2,
        maxConcurrency: 3,
      }),
    );
    expect(preview.startsNow).toBe(2);
    expect(preview.queued).toBe(1);
    expect(preview.idle).toBe(false);
    expect(preview.summary).toBe('Starts 2 tasks now · 1 then queued');
  });

  it('singularizes a one-task start', () => {
    const preview = armPreview(
      projection({ entries: [entry({ taskId: 'a' })], startsNowCount: 1, freeSlots: 1 }),
    );
    expect(preview.summary).toBe('Starts 1 task now');
  });

  it('says nothing starts now when every slot is busy', () => {
    const preview = armPreview(
      projection({
        entries: [entry({ taskId: 'a', position: 1, wave: 1, startsNow: false })],
        startsNowCount: 0,
        freeSlots: 0,
        maxConcurrency: 2,
      }),
    );
    expect(preview.summary).toBe('Starts nothing right now · 1 then queued');
    expect(preview.idle).toBe(false);
  });

  it('surfaces unreachable tasks as blocked rather than hiding them', () => {
    const preview = armPreview(
      projection({ unreachable: ['ghost', 'after-failed'], freeSlots: 3, maxConcurrency: 3 }),
    );
    expect(preview.stuck).toBe(2);
    expect(preview.idle).toBe(false);
    expect(preview.summary).toBe('Starts nothing right now · 2 tasks blocked');
  });
});
