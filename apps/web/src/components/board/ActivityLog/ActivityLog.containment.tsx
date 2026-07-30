/** The per-session OS write-containment badge (T16 / #157) — split out of
 *  `ActivityLog.tsx` to keep it under the file-size ratchet. */
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui';

import type { SessionGroup } from '../session-stream';

/** The OS write-containment badge for one session (T16 / #157) — the LOUD half of
 *  the sandbox-by-default staging.
 *
 *  Renders nothing when the run never asked for containment (every scan/probe, and
 *  every run on the pre-staging default), a quiet confirmation when it applied, and
 *  a WARNING chip naming the reason when it was requested but the host could not
 *  provide it. That last case is why this exists: with `failIfUnavailable: false`
 *  the run continues under the PreToolUse gate alone, and a degrade the user cannot
 *  see is a degrade they will assume never happened. */
export function ContainmentBadge({
  containment,
}: {
  containment: SessionGroup['containment'];
}): ReactNode {
  if (containment === null) return null;
  if (containment.active) {
    return (
      <Badge tone="success" className="shrink-0">
        Contained
      </Badge>
    );
  }
  const detail =
    `OS write containment was requested but is unavailable: ${
      containment.reason ?? 'this host cannot provide it'
    }. The run continued under Nightcore's tool-input policy gate only.`;
  return (
    // The reason is rendered into the DOM (native `title` + screen-reader text)
    // rather than a hover-only tooltip: this is the one badge whose DETAIL is the
    // point, and a governance signal a user has to discover by hovering is a
    // governance signal most users never read.
    <span title={detail} className="shrink-0">
      <Badge tone="warning">Containment unavailable</Badge>
      <span className="sr-only">{detail}</span>
    </span>
  );
}

