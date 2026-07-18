/**
 * Seat-role visual tone map (GOV-20). A seat's asymmetric role is what makes a debate
 * produce genuine disagreement, so the role badge is toned by role — consistently
 * across the seat canvas, the reply diff, and the converge gavel — rather than every
 * seat reading the same accent. Total over `DebateSeatRole` so a new role must pick a
 * tone here. `conductor`/`human` aren't debating seats (they surface elsewhere), so
 * they carry the muted/neutral default.
 */
import type { BadgeTone } from '@/components/ui';
import type { DebateSeatRole } from '@/lib/bridge';

/** Badge tone per seat role: proposer=primary, critic=warning, judge=info. */
export const SEAT_ROLE_TONE: Record<DebateSeatRole, BadgeTone> = {
  proposer: 'primary',
  critic: 'warning',
  judge: 'info',
  conductor: 'neutral',
  human: 'info',
};
