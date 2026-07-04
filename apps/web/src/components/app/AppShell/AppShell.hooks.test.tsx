import { expect, test } from 'vitest';

import type { Task } from '@/lib/bridge';

import { runningTaskCount } from './AppShell.hooks';

/** Build a minimal Task carrying just the `status` the counter reads. */
function task(id: string, status: Task['status']): Task {
  return { id, status } as Task;
}

test('counts every in_progress and verifying task, not just presence', () => {
  const tasks = [
    task('a', 'in_progress'),
    task('b', 'in_progress'),
    task('c', 'verifying'),
    task('d', 'backlog'),
    task('e', 'done'),
  ];
  // The sidebar footer bug reported 1 (boolean coerced) even with 3 concurrent
  // runs — the count must be the real total of active tasks.
  expect(runningTaskCount(tasks)).toBe(3);
});

test('returns 0 when nothing is active', () => {
  expect(runningTaskCount([task('a', 'backlog'), task('b', 'done')])).toBe(0);
  expect(runningTaskCount([])).toBe(0);
});
