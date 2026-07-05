/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  type Config,
  ConfigSchema,
  type NightcoreEvent,
  type SurfaceCommand,
} from '@nightcore/contracts';

import { ScanRouter } from './scan-router.js';

/**
 * Pins that the ScanRouter OWNS the `runId`-keyed `issue-validation` family — that
 * `handles()` recognizes both `start-` and `cancel-issue-validation`, and that `dispatch`
 * delegates a `start` to the issue-triage manager rather than letting it fall through to
 * the supervisor's `command.sessionId` lookup (where it would be dropped as an "unknown
 * session"). `manager.test.ts` exercises the manager in isolation and
 * `session-manager.test.ts` only covers the `cancel` route, so without this a lost
 * `start-issue-validation` case in `handles()`/`dispatch()` would go unnoticed.
 */

const BASE_CONFIG: Config = ConfigSchema.parse({
  paths: { home: '/tmp/nc-home', sessions: '/tmp/nc-home/sessions' },
});

let PROJECT_DIR: string;
beforeAll(() => {
  PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-router-'));
});
afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

function startIssueValidation(): Extract<
  SurfaceCommand,
  { type: 'start-issue-validation' }
> {
  return {
    type: 'start-issue-validation',
    runId: 'run-iv-router',
    projectPath: PROJECT_DIR,
    issueNumber: 7,
    issueTitle: 'Something broke',
    issueBody: 'white screen',
    issueAuthor: 'octocat',
    labels: [],
    comments: [],
    linkedPrs: [],
  };
}

const cancelIssueValidation: Extract<
  SurfaceCommand,
  { type: 'cancel-issue-validation' }
> = { type: 'cancel-issue-validation', runId: 'run-iv-router' };

describe('ScanRouter — issue-validation routing', () => {
  test('handles() recognizes the issue-validation family (start + cancel)', () => {
    const router = new ScanRouter({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit: () => {},
    });
    expect(router.handles(startIssueValidation())).toBe(true);
    expect(router.handles(cancelIssueValidation)).toBe(true);
    // A session-id-keyed command is NOT owned by the router (contrast that keeps the
    // assertion honest — it must fall through to the supervisor's sessionId lookup).
    expect(router.handles({ type: 'interrupt', sessionId: 1 })).toBe(false);
  });

  test('dispatch(start-issue-validation) delegates to the issue-triage manager', async () => {
    const events: NightcoreEvent[] = [];
    const router = new ScanRouter({
      config: BASE_CONFIG,
      apiKeyFallback: false,
      emit: (e) => events.push(e),
    });

    // The manager emits `issue-validation-started` synchronously at the top of its run,
    // BEFORE the first `await` — so dispatch delegating to it is observable immediately
    // (had `dispatch` fallen through instead, no such event would be emitted).
    router.dispatch(startIssueValidation());
    expect(events.some((e) => e.type === 'issue-validation-started')).toBe(true);

    // Cancel synchronously: this lands before the run's async continuation reaches the
    // session pool, so NO real SDK session is ever spawned (the worker sees `cancelled`
    // and returns). The run then retires with an `aborted` failure — hermetic teardown.
    router.dispatch(cancelIssueValidation);
    await new Promise((r) => setTimeout(r, 0));
    const failed = events.find((e) => e.type === 'issue-validation-failed');
    expect(failed?.type === 'issue-validation-failed' && failed.reason).toBe(
      'aborted',
    );
  });
});
