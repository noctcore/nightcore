// AutoModeOptions is settings content only — popover open/close lives in
// `ToolbarOption.hooks.ts`. This module holds the arm-preview derivation (#402); it also
// satisfies the folder-per-component sibling contract.
import { type ArmPreview, armPreview, useRunOrder } from '../run-order';

/** The Auto-Mode ARM PREVIEW (#402): what arming the loop right now would actually do,
 *  read straight off the coordinator's projected run order.
 *
 *  The gap this closes: the toggle told you nothing until AFTER you flipped it, so on a
 *  20+ task board arming was a leap — you learned "that started 3 runs" by watching cards
 *  move. Reading the projection here (the same `startsNowCount` the very next tick
 *  launches) makes it a before-the-click answer.
 *
 *  It uses the shared `armPreview` derivation rather than recomputing, so this popover and
 *  the toolbar toggle's tooltip can never disagree. Falls back to the empty projection
 *  outside a provider (stories/tests). */
export function useAutoModeArmPreview(): ArmPreview {
  return armPreview(useRunOrder());
}
