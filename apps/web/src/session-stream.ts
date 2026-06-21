import type { NcEvent } from './bridge';

export interface ToolLine {
  id: number;
  toolName: string;
}

/** Assembled live output for a single task's run, derived from `nc:session`. */
export interface SessionStream {
  answer: string;
  tools: ToolLine[];
  costUsd: number | null;
  error: string | null;
  /** Whether the active turn streamed partial deltas, so the final
   *  whole-message block (partial: false) can be suppressed. */
  streamedPartial: boolean;
  toolSeq: number;
}

export const EMPTY_STREAM: SessionStream = {
  answer: '',
  tools: [],
  costUsd: null,
  error: null,
  streamedPartial: false,
  toolSeq: 0,
};

/** Fold one engine event into the accumulated stream. Mirrors M0's dedup:
 *  append partial deltas, suppress the final whole-message block when partials
 *  streamed, and reset the partial flag on each tool use. */
export function foldSession(prev: SessionStream, event: NcEvent): SessionStream {
  switch (event.type) {
    case 'session-started':
    case 'session-ready':
      return { ...EMPTY_STREAM };
    case 'assistant-delta': {
      if (event.partial) {
        return {
          ...prev,
          streamedPartial: true,
          answer: prev.answer + event.text,
        };
      }
      if (prev.streamedPartial) return prev;
      return { ...prev, answer: prev.answer + event.text };
    }
    case 'tool-use-requested': {
      const nextSeq = prev.toolSeq + 1;
      return {
        ...prev,
        streamedPartial: false,
        toolSeq: nextSeq,
        tools: [...prev.tools, { id: nextSeq, toolName: event.toolName }],
      };
    }
    case 'session-completed':
      return { ...prev, costUsd: event.costUsd };
    case 'session-failed':
      return { ...prev, error: `${event.reason}: ${event.message}` };
    default:
      return prev;
  }
}
