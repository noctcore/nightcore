import { Terminal } from '@xterm/xterm';
import { afterEach, expect, test } from 'vitest';

import {
  attentionLevel,
  clearActivity,
  forgetAttention,
  getAttention,
  IDLE_ATTENTION,
  installCompletionSignals,
  nextAttentionId,
  recordActivity,
  recordAttention,
  setActiveTerminal,
  setVisibleTerminals,
  type TerminalAttention,
} from './terminal-attention';

// The attention state is module-level (it must survive the view's remounts), so each
// test uses unique ids and resets the visible set + its own ids afterwards.
afterEach(() => {
  setVisibleTerminals([]);
  for (const id of ['a', 'b', 'c', 'osc', 'bell']) forgetAttention(id);
});

test('attentionLevel: needs-attention outranks has-output outranks idle', () => {
  expect(attentionLevel(undefined)).toBe('idle');
  expect(attentionLevel(IDLE_ATTENTION)).toBe('idle');
  expect(attentionLevel({ unread: 3, needsAttention: false })).toBe('has-output');
  // needs-attention wins even with unread output present.
  expect(attentionLevel({ unread: 3, needsAttention: true })).toBe('needs-attention');
  expect(attentionLevel({ unread: 0, needsAttention: true })).toBe('needs-attention');
});

test('off-screen output accrues unread; a completion signal flips needs-attention', () => {
  setActiveTerminal(null); // nothing visible → every id accrues
  recordActivity('a');
  recordActivity('a');
  expect(getAttention('a')).toEqual({ unread: 2, needsAttention: false });

  // A completion/awaiting signal (OSC/BEL) flips the LOUD state; returns true once.
  expect(recordAttention('a')).toBe(true);
  expect(getAttention('a').needsAttention).toBe(true);
  // A second signal while already waiting does not re-flip.
  expect(recordAttention('a')).toBe(false);

  // Viewing the tab clears BOTH unread and needs-attention.
  clearActivity('a');
  expect(getAttention('a')).toEqual(IDLE_ATTENTION);
});

test('a visible session never accrues output or attention', () => {
  setVisibleTerminals(['b']);
  recordActivity('b');
  expect(recordAttention('b')).toBe(false);
  expect(getAttention('b')).toEqual(IDLE_ATTENTION);
});

test('nextAttentionId cycles through waiting sessions after the current one', () => {
  const attention: Record<string, TerminalAttention> = {
    a: { unread: 0, needsAttention: true },
    b: { unread: 1, needsAttention: false },
    c: { unread: 0, needsAttention: true },
  };
  const order = ['a', 'b', 'c'];
  // From `a` (waiting), the next waiting after it is `c`.
  expect(nextAttentionId(order, 'a', attention)).toBe('c');
  // From `c`, it wraps back to `a`.
  expect(nextAttentionId(order, 'c', attention)).toBe('a');
  // With no active tab, the first waiting session.
  expect(nextAttentionId(order, null, attention)).toBe('a');
  // Nothing waiting → null.
  expect(nextAttentionId(order, 'a', { a: IDLE_ATTENTION })).toBeNull();
});

test('installCompletionSignals: an OSC 777 or a BEL from the shell flips needs-attention', async () => {
  setActiveTerminal(null); // the pane is off-screen, so a signal must register
  const term = new Terminal();

  const oscDisposables = installCompletionSignals(term, 'osc');
  // urxvt-style desktop notification the shell emits on completion.
  await new Promise<void>((resolve) => term.write('\x1b]777;notify;done;ok\x07', resolve));
  expect(getAttention('osc').needsAttention).toBe(true);

  const bellTerm = new Terminal();
  const bellDisposables = installCompletionSignals(bellTerm, 'bell');
  await new Promise<void>((resolve) => bellTerm.write('\x07', resolve));
  expect(getAttention('bell').needsAttention).toBe(true);

  for (const d of [...oscDisposables, ...bellDisposables]) d.dispose();
  term.dispose();
  bellTerm.dispose();
});
