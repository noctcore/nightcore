/** Status-to-style lookups for gauntlet/structure-lock step rows. */
import type { GauntletStep } from '@/lib/bridge';

/** Tailwind text class for a gauntlet step status (design palette). */
export const STEP_STATUS_TEXT: Record<GauntletStep['status'], string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
};

/** A short glyph for a step's status, for the leading status marker. */
export const STEP_STATUS_GLYPH: Record<GauntletStep['status'], string> = {
  passed: '✓',
  failed: '✕',
  skipped: '–',
};
