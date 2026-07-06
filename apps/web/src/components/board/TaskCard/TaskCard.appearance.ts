/** TaskCard appearance tokens: the card container + action-button class strings and
 *  the per-status container treatment. Kept beside `TaskCard.tsx` so the card entry
 *  file stays presentational markup, not a wall of Tailwind constants. */

export const CARD_BASE =
  'nc-board-card group relative w-full rounded-xl border bg-card p-3.5 text-left transition-[border-color,box-shadow,background]';

/** Container classes per status, always using the glow treatment. The
 *  running-accent glow stays; a verifying task carries the primary-tinted
 *  reviewer glow. */
export function containerClass(status: string, running: boolean, selected: boolean): string {
  if (running) {
    return 'border-warning/55 shadow-[0_0_0_1px_oklch(80%_.14_75_/_.3),0_10px_34px_-8px_oklch(80%_.14_75_/_.45)]';
  }
  if (status === 'verifying') {
    return 'border-primary/55 shadow-[0_0_0_1px_oklch(74%_.13_280_/_.3),0_10px_34px_-8px_oklch(74%_.13_280_/_.45)]';
  }
  if (status === 'failed') {
    return 'border-destructive/45 shadow-[0_0_0_1px_oklch(66%_.2_22_/_.2),0_8px_26px_-14px_oklch(66%_.2_22_/_.4)]';
  }
  if (status === 'done') {
    return 'border-border border-l-2 border-l-success/50 shadow-[0_0_0_1px_oklch(76%_.15_152_/_.16),0_8px_26px_-14px_oklch(76%_.15_152_/_.4)]';
  }
  const base = selected ? 'border-primary/60' : 'border-border hover:border-white/20';
  return `${base} shadow-[0_8px_22px_-14px_oklch(0%_0_0_/_.9)]`;
}

export const ACTION_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-[filter,background] disabled:cursor-not-allowed';
export const ACTION_PRIMARY = 'flex-1 bg-primary text-primary-foreground hover:brightness-110';
export const ACTION_GHOST = 'flex-1 border border-border text-foreground hover:bg-white/[0.05]';
export const ACTION_DANGER =
  'bg-destructive/[0.14] text-destructive border border-destructive/30 hover:brightness-110';
export const ACTION_DISABLED = 'flex-1 border border-border bg-white/[0.04] text-muted-foreground';
