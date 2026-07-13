import { useState } from 'react';

/** Local composer state: the draft message and the broadcast-armed toggle. Held in
 *  the `.hooks.ts` sibling per the folder-per-component convention (no state in the
 *  component body). The armed flag is derived against eligibility in the component
 *  (`broadcast && canBroadcast`), so a session count collapsing to one auto-disarms
 *  the fan-out without this state having to be reset. */
export function useSessionComposer() {
  const [text, setText] = useState('');
  const [broadcast, setBroadcast] = useState(false);
  return { text, setText, broadcast, setBroadcast };
}
