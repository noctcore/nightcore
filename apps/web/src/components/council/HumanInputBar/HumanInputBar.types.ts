/** Props + shared shapes for the {@link import('./HumanInputBar').HumanInputBar} — the
 *  conductor-mediated human-input bar (issue #361). */
import type { CouncilHumanInputMode } from '@/lib/bridge';

/** Dispatch the human's message through the CONDUCTOR (never `sendInput`). The Conductor
 *  quotes + injection-scans it and stages it for the target seat(s)' next mediated turn;
 *  a rejection is surfaced inline so the human can retry. `seatId` is set only for a
 *  `direct` message. */
export type HumanInputSend = (
  mode: CouncilHumanInputMode,
  message: string,
  seatId?: string,
) => Promise<void>;

export interface HumanInputBarProps {
  /** The run's live seat ids — the DM-one recipient list. Empty until the seats have
   *  spoken, which is when a direct message becomes addressable. */
  seatIds: string[];
  /** Dispatch the message through the Conductor. Rejections surface inline. */
  onSend: HumanInputSend;
  /** True only while a run is LIVE. When false the bar renders its DISABLED affordance —
   *  there is no run to address, so nothing can be relayed. */
  live: boolean;
}
