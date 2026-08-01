import { describe, expect, it } from 'bun:test';

import { FindingSeveritySchema } from './insight.js';
import { ReviewSeveritySchema } from './pr-review.js';
import { SeveritySchema } from './severity.js';

/** Issue #178 consolidated three declarations of one five-level scale into one.
 *  These pin the consolidation itself: the per-family names must stay ALIASES (same
 *  object), not copies that could drift back apart, and the value-set must stay
 *  exactly what the Rust emitter keys `FindingSeverity` on. */
describe('the one severity scale', () => {
  it('is five levels ordered low→high', () => {
    expect(SeveritySchema.options).toEqual([
      'info',
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });

  it('is the SAME schema object the per-family names point at', () => {
    // Not `toEqual` — identity. A structural copy would satisfy a deep-equal check
    // while re-opening the drift this consolidation closed.
    expect(FindingSeveritySchema).toBe(SeveritySchema);
    expect(ReviewSeveritySchema).toBe(SeveritySchema);
  });

  it('keys the generated Rust enum on the value-set the emitter registered', () => {
    // `tools/codegen/gen-rust-contracts.ts` maps the signature
    // `info|low|medium|high|critical` → `FindingSeverity`. Changing the members
    // without updating ENUM_NAMES emits a differently-named Rust enum.
    expect(SeveritySchema.options.join('|')).toBe('info|low|medium|high|critical');
  });
});
