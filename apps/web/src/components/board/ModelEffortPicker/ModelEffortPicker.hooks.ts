import { MODEL_OPTIONS } from '../status';

/** Resolve which model option a stored value selects. The store may hold a
 *  canonical id (`claude-opus-4-8`) or a legacy short id (`opus-4.8`); both match
 *  the option by family so the picker highlights the right chip. Returns `null`
 *  (Inherit) when the value is null or unrecognized. Pure. */
export function activeModelId(model: string | null): string | null {
  if (model === null) return null;
  if (MODEL_OPTIONS.some((option) => option.id === model)) return model;
  const family = model.toLowerCase();
  const match = MODEL_OPTIONS.find((option) => {
    const f = option.label.toLowerCase().split(' ')[0] ?? '';
    return family.includes(f);
  });
  return match?.id ?? null;
}
