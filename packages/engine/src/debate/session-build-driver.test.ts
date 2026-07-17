/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { TokenUsage, WorktreeOpKind } from '@nightcore/contracts';

import type { BuildContext } from './build-writer.js';
import type { SeatContext, SeatTurnRequest, SeatTurnResult } from './conductor-types.js';
import { SessionBuildDriver } from './session-build-driver.js';
import { WorktreeOpBroker, type WorktreeOpReply } from './worktree-rpc.js';

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

const WRITER: SeatContext = {
  seatId: 'proposer-opus',
  role: 'proposer',
  model: 'claude-opus-4-8',
};

const WORKTREE = '/proj/.nightcore/worktrees/run-1';

/** A REAL broker whose fake `emit` immediately answers each op — exercises the real
 *  request/correlate/resolve round-trip without a live host. */
function respondingBroker(reply: (op: WorktreeOpKind) => WorktreeOpReply): {
  broker: WorktreeOpBroker;
  ops: WorktreeOpKind[];
} {
  const ops: WorktreeOpKind[] = [];
  const broker = new WorktreeOpBroker({
    emit: (event) => {
      if (event.type !== 'worktree-op-required') return;
      ops.push(event.op);
      // The resolver is registered BEFORE `request` emits, so a synchronous reply settles it.
      broker.resolve(event.requestId, reply(event.op));
    },
  });
  return { broker, ops };
}

function context(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    councilRunId: 'run-1',
    objective: 'fix the broken submit button',
    writer: WRITER,
    plan: 'BEGIN UNTRUSTED … the converged plan … END UNTRUSTED',
    cwd: '/proj',
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('SessionBuildDriver', () => {
  test('allocates, runs the writer in the ALLOCATED worktree, commits, and returns the worktree', async () => {
    const { broker, ops } = respondingBroker((op) =>
      op === 'allocate' ? { worktreePath: WORKTREE } : {},
    );
    const writerCalls: SeatTurnRequest[] = [];
    const driver = new SessionBuildDriver({
      broker,
      runWriter: (request): Promise<SeatTurnResult> => {
        writerCalls.push(request as SeatTurnRequest);
        return Promise.resolve({ content: 'applied the diff', usage: NO_USAGE, costUsd: 0.5 });
      },
    });

    const result = await driver.build(context());

    // The ops ran in order: allocate the worktree, then commit the writer's edits. NEVER a
    // merge (merge/discard stay human-only).
    expect(ops).toEqual(['allocate', 'commit']);
    expect(ops).not.toContain('merge');

    // EXACTLY ONE writer session ran, in the ALLOCATED worktree (not the project root), at
    // the `build` stage, with the mediated plan in its prompt.
    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0]?.cwd).toBe(WORKTREE);
    expect(writerCalls[0]?.stage).toBe('build');
    expect(writerCalls[0]?.seat.seatId).toBe(WRITER.seatId);
    expect(writerCalls[0]?.prompt).toContain('the converged plan');
    expect(writerCalls[0]?.prompt).toContain('ONLY session permitted to write');

    // The result carries the worktree so the objective gate judges the BUILD OUTPUT there.
    expect(result.worktreePath).toBe(WORKTREE);
    expect(result.content).toBe('applied the diff');
    expect(result.costUsd).toBe(0.5);
  });

  test('FAILS CLOSED when allocation fails — throws so nothing un-built is ever judged', async () => {
    const { broker } = respondingBroker((op) =>
      op === 'allocate' ? { error: 'disk full' } : {},
    );
    let writerRan = false;
    const driver = new SessionBuildDriver({
      broker,
      runWriter: () => {
        writerRan = true;
        return Promise.resolve({ content: '', usage: NO_USAGE, costUsd: 0 });
      },
    });

    await expect(driver.build(context())).rejects.toThrow(/could not allocate/);
    // The writer never ran — there was no confined worktree to run it in.
    expect(writerRan).toBe(false);
  });

  test('FAILS CLOSED on an EMPTY-string worktree path — never runs the writer at the process root (issue #387)', async () => {
    // A host bug returning `worktreePath: ''` (rather than a real path or an error) must not
    // slip past the guard and run the write-capable writer with an empty cwd — that would
    // execute at the process root, outside every worktree confinement.
    const { broker } = respondingBroker((op) =>
      op === 'allocate' ? { worktreePath: '' } : {},
    );
    let writerRan = false;
    const driver = new SessionBuildDriver({
      broker,
      runWriter: () => {
        writerRan = true;
        return Promise.resolve({ content: '', usage: NO_USAGE, costUsd: 0 });
      },
    });

    await expect(driver.build(context())).rejects.toThrow(/could not allocate/);
    expect(writerRan).toBe(false);
  });

  test('a failed commit does NOT fail the build — the gate judges the working tree regardless', async () => {
    const { broker, ops } = respondingBroker((op) => {
      if (op === 'allocate') return { worktreePath: WORKTREE };
      if (op === 'commit') return { error: 'nothing staged / git error' };
      return {};
    });
    const driver = new SessionBuildDriver({
      broker,
      runWriter: () => Promise.resolve({ content: 'diff', usage: NO_USAGE, costUsd: 0 }),
    });

    const result = await driver.build(context());
    // The commit was attempted and failed, but the build still returns its worktree.
    expect(ops).toEqual(['allocate', 'commit']);
    expect(result.worktreePath).toBe(WORKTREE);
    expect(result.content).toBe('diff');
  });
});
