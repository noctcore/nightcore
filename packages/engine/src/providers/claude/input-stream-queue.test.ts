/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { WireImage } from '@nightcore/contracts';

import { InputStreamQueue } from './input-stream-queue.js';

/** Drain up to `n` messages from a queue's stream, then stop consuming. */
async function take(
  queue: InputStreamQueue,
  n: number,
): Promise<Array<{ content: unknown }>> {
  const out: Array<{ content: unknown }> = [];
  for await (const msg of queue.stream()) {
    out.push({ content: msg.message.content });
    if (out.length >= n) break;
  }
  return out;
}

describe('InputStreamQueue', () => {
  test('a text-only push streams a plain-string user message (FIFO order)', async () => {
    const queue = new InputStreamQueue();
    queue.push('first');
    queue.push('second');
    queue.close();

    const messages = await take(queue, 2);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  test('images are folded into a text + base64-image content array', async () => {
    const queue = new InputStreamQueue();
    const images: WireImage[] = [{ format: 'png', data: 'AAAA' }];
    queue.push('look', images);
    queue.close();

    const [message] = await take(queue, 1);
    expect(message.content).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ]);
  });

  test('stream() parks on an empty queue and resumes when a message is pushed', async () => {
    const queue = new InputStreamQueue();
    // Begin consuming before anything is enqueued: the generator must park.
    const first = (async () => {
      for await (const msg of queue.stream()) {
        return msg.message.content;
      }
      return undefined;
    })();

    // Nothing has been pushed yet — give the generator a tick to park, then feed it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.push('delivered late');

    await expect(first).resolves.toBe('delivered late');
  });

  test('stream() returns after draining once the queue is closed', async () => {
    const queue = new InputStreamQueue();
    queue.push('only');
    queue.close();

    const collected: unknown[] = [];
    for await (const msg of queue.stream()) {
      collected.push(msg.message.content);
    }
    // The loop terminated on close (did not hang) after yielding the queued message.
    expect(collected).toEqual(['only']);
  });

  test('push after close is dropped (a late streamInput never resurrects the stream)', async () => {
    const queue = new InputStreamQueue();
    queue.close();
    queue.push('too late');

    const collected: unknown[] = [];
    for await (const msg of queue.stream()) {
      collected.push(msg.message.content);
    }
    expect(collected).toEqual([]);
  });
});
