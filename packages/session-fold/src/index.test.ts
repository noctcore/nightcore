/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  decideAssistantDelta,
  INITIAL_STREAMED_PARTIAL,
  streamedPartialAfterBoundary,
} from './index.js';

describe('decideAssistantDelta — partial deltas', () => {
  test('a partial delta appends when a turn is open', () => {
    expect(
      decideAssistantDelta({ partial: true, streamedPartial: true, hasOpenTurn: true }),
    ).toEqual({ action: 'append', streamedPartial: true });
  });

  test('a partial delta opens a fresh turn when none is open', () => {
    expect(
      decideAssistantDelta({ partial: true, streamedPartial: false, hasOpenTurn: false }),
    ).toEqual({ action: 'open', streamedPartial: true });
  });

  test('the first partial of a turn opens and flips streamedPartial true', () => {
    const d = decideAssistantDelta({
      partial: true,
      streamedPartial: false,
      hasOpenTurn: false,
    });
    expect(d.action).toBe('open');
    expect(d.streamedPartial).toBe(true);
  });
});

describe('decideAssistantDelta — whole-message blocks', () => {
  test('suppresses the whole-message block once partials streamed (dedup)', () => {
    expect(
      decideAssistantDelta({ partial: false, streamedPartial: true, hasOpenTurn: true }),
    ).toEqual({ action: 'suppress', streamedPartial: true });
  });

  test('a whole-message block opens a turn when no partials streamed', () => {
    expect(
      decideAssistantDelta({ partial: false, streamedPartial: false, hasOpenTurn: false }),
    ).toEqual({ action: 'open', streamedPartial: false });
  });

  test('a whole-message block never appends — it opens or suppresses', () => {
    // Even if a turn is somehow open, a non-partial block is whole text, never a
    // delta to concatenate.
    const kept = decideAssistantDelta({
      partial: false,
      streamedPartial: false,
      hasOpenTurn: true,
    });
    expect(kept.action).toBe('open');
  });
});

describe('boundary + initial flag transitions', () => {
  test('a turn-ending boundary clears streamedPartial', () => {
    expect(streamedPartialAfterBoundary()).toBe(false);
  });

  test('a fresh session starts with streamedPartial false', () => {
    expect(INITIAL_STREAMED_PARTIAL).toBe(false);
  });
});
