/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  bashDenyReason,
  protectedPathReason,
  readDenyReason,
  toolAskReason,
  toolDenyReason,
} from './reasons.js';

describe('reason builders', () => {
  test('protectedPathReason names the target and the matched pattern', () => {
    const reason = protectedPathReason('/repo/bun.lock', 'bun.lock');
    expect(reason).toContain('/repo/bun.lock');
    expect(reason).toContain('"bun.lock"');
  });

  test('bashDenyReason names the matched pattern', () => {
    expect(bashDenyReason('--no-verify')).toContain('"--no-verify"');
  });

  test('readDenyReason names the target and the matched pattern', () => {
    const reason = readDenyReason('/repo/.env', '.env*');
    expect(reason).toContain('/repo/.env');
    expect(reason).toContain('".env*"');
  });

  test('toolDenyReason names the tool', () => {
    expect(toolDenyReason('WebSearch')).toContain('WebSearch');
  });

  test('toolAskReason names the tool and mentions interactive approval', () => {
    const reason = toolAskReason('WebFetch');
    expect(reason).toContain('WebFetch');
    expect(reason).toContain('interactive approval');
  });
});
