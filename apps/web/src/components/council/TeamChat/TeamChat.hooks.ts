/**
 * Follow-the-stream behavior for the {@link import('./TeamChat').TeamChat} projection
 * (GOV-1). The bus streams append-only, so the panel STICKS to the bottom while the
 * reader is at/near it, and when the reader has scrolled up to inspect an earlier entry
 * it stops yanking them down and offers a "Jump to latest" chip instead. State lives here
 * (no-state-in-body); the pinned flag is a ref so the append effect and the scroll handler
 * read the freshest value without re-subscribing.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Distance from the bottom (px) still treated as "pinned" — a tiny scroll-up keeps following. */
const NEAR_BOTTOM_PX = 48;

export interface TeamChatFollow {
  /** Ref for the scrollable list — its scroll geometry drives the follow behavior. */
  scrollRef: RefObject<HTMLOListElement | null>;
  /** Wire to the list's `onScroll` to track whether the reader is pinned to the bottom. */
  onScroll: () => void;
  /** True when the reader scrolled up while new entries arrived — shows the jump chip. */
  showJump: boolean;
  /** Scroll to the newest entry and re-pin. */
  jumpToLatest: () => void;
}

export function useTeamChatFollow(entryCount: number): TeamChatFollow {
  const scrollRef = useRef<HTMLOListElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setShowJump(false);
  }, []);

  // On a new entry, keep the view pinned to the bottom when the reader was already there;
  // otherwise surface the jump chip so they can catch up on demand.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [entryCount]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distance <= NEAR_BOTTOM_PX;
    pinnedRef.current = pinned;
    if (pinned) setShowJump(false);
  }, []);

  return { scrollRef, onScroll, showJump, jumpToLatest };
}
