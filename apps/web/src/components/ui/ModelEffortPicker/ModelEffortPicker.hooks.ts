/** Selection-resolution helper for the ModelEffortPicker. */
import { modelOptionFor } from '@/lib/models';

/** Resolve which model option a stored value selects. The store may hold a
 *  canonical id (`claude-opus-4-8`) or a legacy short id (`opus-4.8`); both match
 *  the option by family so the picker highlights the right chip. Returns `null`
 *  (Inherit) when the value is null or unrecognized. Delegates the resolution to
 *  the shared `modelOptionFor` so the family-match rule lives in one place. Pure. */
export function activeModelId(model: string | null): string | null {
  return modelOptionFor(model)?.id ?? null;
}
