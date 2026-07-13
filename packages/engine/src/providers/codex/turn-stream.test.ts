/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { NightcoreEvent } from '@nightcore/contracts';

import { createCodexTranslationState, type ThreadEvent } from './sdk-adapter.js';
import { CODEX_IDLE_STALLED, drainTurnEvents } from './turn-stream.js';

function collector(): {
  emit: (event: NightcoreEvent) => void;
  events: NightcoreEvent[];
} {
  const events: NightcoreEvent[] = [];
  return { emit: (event) => events.push(event), events };
}

async function* eventsFrom(items: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const item of items) yield item;
}

describe('drainTurnEvents', () => {
  test('emits non-terminal events as they arrive and holds the terminal ones', async () => {
    const state = createCodexTranslationState({ sessionId: 1, model: 'gpt-5-codex' });
    const { emit, events } = collector();
    const stream = eventsFrom([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'done' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ]);

    const held = await drainTurnEvents(stream, state, emit, 1000);

    // `thread.started` and `item.completed` were emitted immediately as they
    // arrived, NOT held.
    expect(events.map((e) => e.type)).toEqual(['session-ready', 'assistant-delta']);
    // The terminal `turn.completed`'s `session-completed` is held, not emitted.
    expect(held).not.toBe(CODEX_IDLE_STALLED);
    expect(held).not.toBeUndefined();
    expect((held as NightcoreEvent[])[0]).toMatchObject({
      type: 'session-completed',
      sessionId: 1,
      result: 'done',
    });
  });

  test('returns undefined when the stream ends without a terminal event', async () => {
    const state = createCodexTranslationState({ sessionId: 2, model: 'gpt-5-codex' });
    const { emit } = collector();
    const stream = eventsFrom([
      { type: 'thread.started', thread_id: 'thread-2' },
      { type: 'turn.started' },
    ]);

    const held = await drainTurnEvents(stream, state, emit, 1000);
    expect(held).toBeUndefined();
  });

  test('trips the idle watchdog when the stream stops yielding without a terminal event', async () => {
    const state = createCodexTranslationState({ sessionId: 3, model: 'gpt-5-codex' });
    const { emit, events } = collector();
    async function* wedge(): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'thread-3' };
      yield { type: 'turn.started' };
      // Wedge: park forever with no further (and no terminal) event.
      await new Promise<void>(() => {});
    }

    // A short idle deadline so the watchdog trips at once instead of after the
    // production default.
    const held = await drainTurnEvents(wedge(), state, emit, 20);
    expect(held).toBe(CODEX_IDLE_STALLED);
    // The events preceding the stall were still emitted (fail-visible, not
    // silently swallowed).
    expect(events.map((e) => e.type)).toEqual(['session-ready']);
  });
});
