import { useCallback } from 'react';

import { useLinkedSessionId } from '@/lib/terminal-links';

import { useTaskActions } from '../actions';

/** The linked-terminal chip's state (cockpit spec PR 4, decision 2): the live session
 *  linked to this task (or `null`) and the click handler that routes to the Terminal
 *  view and activates that tab. Reads the link store reactively; the open action comes
 *  from the shared `useTaskActions` context (not a prop). */
export function useTaskCardTerminalChip(taskId: string) {
  const sessionId = useLinkedSessionId(taskId);
  const { onOpenTerminal } = useTaskActions();
  const onOpen = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation(); // don't select the card / start a drag
      if (sessionId !== null) onOpenTerminal?.(sessionId);
    },
    [sessionId, onOpenTerminal],
  );
  return { sessionId, onOpen };
}
