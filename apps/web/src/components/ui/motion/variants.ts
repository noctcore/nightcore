/**
 * Shared, generic motion variants composed from the canonical tokens. Feature-
 * specific choreography stays in the feature (composed from these); never push a
 * board/insight-specific variant down here — `ui/` primitives must stay generic.
 *
 * Every variant is transform + opacity only (compositor-cheap on WebKit) and uses
 * the `initial` / `animate` / `exit` state names so a consumer can drive both a
 * mount transition and an `AnimatePresence` exit from one object.
 */
import type { Variants } from 'motion/react';

import { DURATION, EASE } from './tokens';

/** Fade + rise from 8px below — overlays, dialogs, list items. */
export const fadeRise: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.base, ease: EASE.outQuint },
  },
  exit: {
    opacity: 0,
    y: 6,
    transition: { duration: DURATION.fast, ease: EASE.standard },
  },
};

/** Horizontal slide-in from the right + fade — drawers and sheets. Never animate
 *  width; this rides `x` (transform) only. */
export const slideIn: Variants = {
  initial: { opacity: 0, x: 24 },
  animate: {
    opacity: 1,
    x: 0,
    transition: { duration: DURATION.base, ease: EASE.outQuint },
  },
  exit: {
    opacity: 0,
    x: 24,
    transition: { duration: DURATION.fast, ease: EASE.standard },
  },
};

/** Scale + opacity from the trigger origin — menus and popovers. Pair with a
 *  `transform-origin` matching the trigger corner. */
export const popover: Variants = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: DURATION.fast, ease: EASE.outQuint },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -4,
    transition: { duration: DURATION.instant, ease: EASE.standard },
  },
};

/** Backdrop scrim for a modal overlay — a plain opacity fade in/out. Pairs with a
 *  panel variant (`scaleFade` for centered dialogs, `slideIn` for edge sheets). */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: DURATION.fast, ease: EASE.standard },
  },
  exit: {
    opacity: 0,
    transition: { duration: DURATION.fast, ease: EASE.standard },
  },
};

/** Scale + fade for a centered dialog panel — grows in from 96%, settles out on
 *  exit. Transform + opacity only; drive it from a `Modal`-owned `AnimatePresence`
 *  so the panel animates BOTH mount and unmount. */
export const scaleFade: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: DURATION.base, ease: EASE.outQuint },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: 6,
    transition: { duration: DURATION.fast, ease: EASE.standard },
  },
};

/** A container that staggers its children's `animate` reveal. Give children the
 *  `fadeRise` (or similar) variants and this parent the same state names. */
export const stagger: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
  exit: {},
};
