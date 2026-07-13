/**
 * The streaming-input plumbing for a `SessionRunner`: a queue of user messages
 * plus a single waiter the input generator parks on between messages.
 *
 * The SDK's control requests (`interrupt()` / `setModel()` / …) are only available
 * when the prompt is an `AsyncIterable<SDKUserMessage>` (streaming mode), so the
 * runner never passes a bare string — it drives this queue and hands the SDK
 * {@link InputStreamQueue.stream}. Text + optional images are turned into an
 * `SDKUserMessage` on the way in, so callers speak the wire vocabulary only.
 */
import type { WireImage } from '@nightcore/contracts';

import type { SDKUserMessage } from './sdk-adapter.js';
import { buildUserMessageContent } from './session-options.js';

export class InputStreamQueue {
  private readonly queue: SDKUserMessage[] = [];
  private waiter?: () => void;
  private closed = false;

  /**
   * Enqueue a user message built from `text` + optional `images`. A no-op once the
   * queue is closed, so a late `streamInput` after teardown is dropped rather than
   * resurrecting a settled stream.
   */
  push(text: string, images: WireImage[] = []): void {
    if (this.closed) return;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: buildUserMessageContent(text, images) },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiter?.();
    this.waiter = undefined;
  }

  /** Close the stream: {@link stream} returns after draining, and further
   *  {@link push} calls are dropped. Idempotent. */
  close(): void {
    this.closed = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  /**
   * The `AsyncGenerator<SDKUserMessage>` the SDK consumes as its prompt. Drains the
   * queue, then parks on a fresh waiter until the next {@link push} (or {@link
   * close}) wakes it. Returns only once closed and fully drained.
   */
  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift() as SDKUserMessage;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
