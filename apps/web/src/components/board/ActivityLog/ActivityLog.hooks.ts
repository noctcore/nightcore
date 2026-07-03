import { type RefObject, useEffect, useRef, useState } from 'react';

/** Generic collapse state for a session-log block. The latest session opens by
 *  default (`defaultOpen`); older sessions stay collapsed until clicked. The
 *  initializer runs once — toggling is never fought by re-renders. */
export function useCollapse(defaultOpen: boolean): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(defaultOpen);
  return { open, toggle: () => setOpen((v) => !v) };
}

/** Slack (px) below the fold that still counts as "the user is following the
 *  tail" — a small tolerance so sub-pixel rounding or a single in-flight delta
 *  doesn't drop the stick. */
const NEAR_BOTTOM_PX = 64;

/** The nearest scrollable ancestor of `el` — the element whose `overflow-y` is
 *  `auto`/`scroll` (the transcript flows inside TaskDetail's shared overflow
 *  container, which is that element). Matched on the overflow style alone, not
 *  the current scroll extent, so the listener still attaches before the log has
 *  grown tall enough to overflow. */
function scrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node !== null) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Keeps the live transcript stuck to its newest entry while a run streams — but
 * only while the user is already at the tail, so scrolling up to read history is
 * never yanked back, and following resumes once they return to the bottom.
 *
 * A `scroll` listener on the enclosing overflow container tracks whether the
 * user is near the bottom (held in a ref so it never re-renders the streaming
 * log). Following defaults to on, so opening a running task jumps to the newest
 * token; it only turns off once the user actively scrolls away. `tick` is any
 * value that changes as the transcript grows (entry count + trailing markdown
 * length); `isRunning` gates the behavior to live runs.
 *
 * Returns a ref for a zero-height sentinel placed at the end of the transcript —
 * `scrollIntoView({ block: 'nearest' })` on it scrolls the container just enough
 * to reveal the tail without touching the outer page.
 */
export function useStickToBottom(
  tick: number,
  isRunning: boolean,
): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Whether the user is following the tail. A ref (not state) so the high-rate
  // scroll listener updates it without re-rendering the streaming transcript.
  const followingRef = useRef(true);

  // Track the user's scroll position so a scroll-up suspends auto-follow and a
  // return to the bottom resumes it. Attaches once; the container is stable.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollableAncestor(sentinel);
    if (sentinel === null || container === null) return;
    const onScroll = () => {
      const distance =
        sentinel.getBoundingClientRect().top - container.getBoundingClientRect().bottom;
      followingRef.current = distance <= NEAR_BOTTOM_PX;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // Follow the newest entry as the transcript grows — but only while running and
  // while the user is at the tail.
  useEffect(() => {
    if (!isRunning || !followingRef.current) return;
    sentinelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [tick, isRunning]);

  return sentinelRef;
}
