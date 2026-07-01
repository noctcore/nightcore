/** Board custom-appearance derivation (Custom Background feature).
 *
 *  Pure, side-effect-free mapping from persisted settings → the CSS variables +
 *  data attributes that drive the scoped `.nc-board-appearance` rules in
 *  `styles.css`. Kept out of any component so the resolution/clamp/mapping logic is
 *  unit-testable in isolation (mirrors the sibling `status.ts` board helper). */
import type { CSSProperties } from 'react';
import type { BoardAppearance, Settings } from '@/lib/bridge';

/** The identity appearance: every knob at the value that reproduces the pre-feature
 *  board look. Mirrors the Rust `BoardAppearance::default()` so the web and the store
 *  agree on "untouched". A project with no override resolves to exactly this. */
export const DEFAULT_APPEARANCE: BoardAppearance = {
  cardOpacity: 1,
  columnOpacity: 1,
  showColumnBorders: true,
  showCardBorders: true,
  cardGlassmorphism: false,
  cardBorderOpacity: 1,
  hideBoardScrollbar: false,
};

/** Clamp an opacity into `[0, 1]`; a non-finite value fails safe to `1` (fully
 *  opaque) so a hand-edited settings file can't blank the board. */
export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Normalize a raw (possibly absent) appearance override to a complete, clamped
 *  appearance — the defaults when absent, with all three opacities clamped so a
 *  hand-edited settings file can't push them out of range. */
export function normalizeAppearance(a: BoardAppearance | null | undefined): BoardAppearance {
  const base = a ?? DEFAULT_APPEARANCE;
  return {
    ...base,
    cardOpacity: clampOpacity(base.cardOpacity),
    columnOpacity: clampOpacity(base.columnOpacity),
    cardBorderOpacity: clampOpacity(base.cardBorderOpacity),
  };
}

/** Resolve the effective board appearance for a project: its override's appearance,
 *  else the defaults. Per-project independent — there is no global fallback (that's
 *  the product decision: one project's wallpaper never bleeds into another). */
export function resolveAppearance(
  settings: Settings | null,
  projectId: string | null,
): BoardAppearance {
  const raw =
    projectId !== null ? settings?.projectOverrides[projectId]?.boardAppearance : undefined;
  return normalizeAppearance(raw);
}

/** Whether an appearance equals the identity (pre-feature) look — used to decide
 *  whether the custom-appearance CSS needs to be switched on at all. */
export function isDefaultAppearance(a: BoardAppearance): boolean {
  return (
    a.cardOpacity === 1 &&
    a.columnOpacity === 1 &&
    a.cardBorderOpacity === 1 &&
    a.showColumnBorders &&
    a.showCardBorders &&
    !a.cardGlassmorphism &&
    !a.hideBoardScrollbar
  );
}

/** The board-root presentation derived from a resolved appearance. */
export interface AppearanceView {
  /** Whether the custom-appearance CSS should be active — true when a background
   *  image is set OR any knob differs from the default. When false the board renders
   *  byte-for-byte as it did before the feature (the scoped rules don't apply). */
  active: boolean;
  /** Inline CSS custom properties for the board root (the opacity variables the
   *  scoped `color-mix()` rules read). */
  style: CSSProperties;
  /** `data-*` attributes toggling the scoped CSS rules (glass, borders, scrollbar). */
  dataAttrs: Record<string, string | undefined>;
}

/** Map a resolved appearance (+ whether a background image is present) to the board
 *  root's inline CSS variables and data attributes. This is the single bridge
 *  between the persisted knobs and the `styles.css` rules — the component just
 *  spreads the result onto the root element. */
export function appearanceView(a: BoardAppearance, hasBackground: boolean): AppearanceView {
  const active = hasBackground || !isDefaultAppearance(a);
  return {
    active,
    style: {
      '--nc-card-opacity': String(a.cardOpacity),
      '--nc-column-opacity': String(a.columnOpacity),
      '--nc-card-border-opacity': String(a.cardBorderOpacity),
    } as CSSProperties,
    dataAttrs: {
      'data-board-appearance': active ? 'on' : undefined,
      'data-card-glass': a.cardGlassmorphism ? 'on' : 'off',
      'data-card-borders': a.showCardBorders ? 'on' : 'off',
      'data-column-borders': a.showColumnBorders ? 'on' : 'off',
      'data-hide-scrollbar': a.hideBoardScrollbar ? 'on' : 'off',
    },
  };
}
