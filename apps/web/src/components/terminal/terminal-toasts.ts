/**
 * The Terminal feature's module-level → toast bridge.
 *
 * Several terminal behaviors are decided OUTSIDE React — the keymap and the OSC 133
 * parser both live in module scope so they survive the routed view's remounts — yet
 * they need to tell the user something happened. Each exposes a tiny subscription; this
 * hook is the one place that turns those into toasts, so the view's orchestration hook
 * stays about sessions rather than about notification plumbing (and stays under the
 * file-size ratchet).
 *
 * Bound only while the Terminal view is mounted: these messages are about a gesture the
 * user just made in the view, so there is nothing to say once they navigate away.
 */
import { useEffect } from 'react';

import { useToast } from '@/components/ui';

import { subscribePasteRejected } from './terminal-keymap';
import { subscribeCopyLastOutput } from './terminal-osc133';

/** Subscribe the Terminal view to its module-level notifications:
 *
 *  - **Paste dropped** (spec PR 3b): a clipboard payload over the 1 MB cap was refused
 *    rather than flooded into the PTY.
 *  - **Copy last output** (⌘⇧O, #405): the OSC 133 copy result. The `0`-character case
 *    is reported, not swallowed — a shell with no OSC 133 marks would otherwise make
 *    the shortcut look broken, and the fix ("turn on your shell's integration") is only
 *    actionable if we say it.
 */
export function useTerminalToasts(): void {
  const toast = useToast();

  useEffect(
    () =>
      subscribePasteRejected(() => {
        toast.push({
          tone: 'info',
          title: 'Paste too large',
          description: 'Clipboard content over 1 MB was not pasted into the terminal.',
        });
      }),
    [toast],
  );

  useEffect(
    () =>
      subscribeCopyLastOutput((chars) => {
        if (chars === 0) {
          toast.push({
            tone: 'info',
            title: 'Nothing to copy',
            description:
              'No finished command output yet — this needs shell integration (OSC 133) enabled in your shell.',
          });
          return;
        }
        toast.push({ tone: 'success', title: 'Copied last command output' });
      }),
    [toast],
  );
}
