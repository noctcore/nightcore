/**
 * Tiny typed field extractors for reading a single field off an `unknown` value
 * that is *expected* to be a record. Each helper narrows defensively: it returns
 * `undefined` (or the empty array, for `getStringArray`) unless the value is a
 * non-null object AND the named field already holds the requested primitive.
 *
 * These collapse the hand-repeated `obj as Record<string, unknown>` +
 * `typeof x.field === 'string' ? x.field : undefined` idiom that was duplicated
 * across `sdk-adapter`, `analysis-findings`, and `provider-config` into one place.
 * Behavior is identical to the inline guards they replace.
 */

/** Read `obj[key]` as a record, or `undefined`. */
function asRecord(obj: unknown): Record<string, unknown> | undefined {
  return typeof obj === 'object' && obj !== null
    ? (obj as Record<string, unknown>)
    : undefined;
}

/** `obj[key]` if it is a string, else `undefined`. */
export function getString(obj: unknown, key: string): string | undefined {
  const value = asRecord(obj)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** `obj[key]` if it is a boolean, else `undefined`. */
export function getBoolean(obj: unknown, key: string): boolean | undefined {
  const value = asRecord(obj)?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** `obj[key]` if it is a number, else `undefined`. */
export function getNumber(obj: unknown, key: string): number | undefined {
  const value = asRecord(obj)?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** `obj[key]` if it is a non-null object, else `undefined`. */
export function getObject(
  obj: unknown,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(asRecord(obj)?.[key]);
}

/** `obj[key]` as a string array (filtering out non-string members), or `[]` when
 *  the field is absent or not an array. */
export function getStringArray(obj: unknown, key: string): string[] {
  const value = asRecord(obj)?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}
