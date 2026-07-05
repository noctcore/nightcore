/**
 * Canonical motion tokens — the single source of truth for the animation layer.
 *
 * Durations are SECONDS (what motion/react's `transition` prop consumes); easings
 * are cubic-bezier arrays. These values are MIRRORED as CSS custom properties in
 * `styles.css :root` (`--nc-motion-*` / `--nc-ease-*`) so the CSS keyframe layer
 * (StatusDot/Spinner/Skeleton, `.nc-drawer-enter`) and the JS motion layer never
 * drift. When you change a value here, update the mirror there too (and vice versa).
 *
 * Do NOT read the CSS vars back into JS (`getComputedStyle` is a layout read on the
 * hot path) — import these constants instead.
 */

/** Durations in seconds. */
export const DURATION = {
  /** Press feedback. */
  instant: 0.08,
  /** Popovers, menus, toasts-in. */
  fast: 0.14,
  /** Modals, drawers. */
  base: 0.22,
  /** View/route + splash cross-fade. */
  slow: 0.32,
  /** Progress-bar sweeps. */
  slower: 0.48,
} as const;

/** Easing curves as cubic-bezier control-point arrays. */
export const EASE = {
  /** The app's signature entrance (easeOutQuint) — `cubic-bezier(.22,1,.36,1)`. */
  outQuint: [0.22, 1, 0.36, 1],
  /** Hover / color micro-interactions — `cubic-bezier(.4,0,.2,1)`. */
  standard: [0.4, 0, 0.2, 1],
} as const;
