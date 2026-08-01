import { z } from 'zod';

/**
 * `@nightcore/contracts` — the ONE severity scale.
 *
 * Every grounded-finding surface in the product ranks on the same five levels:
 * Insight findings, Harness convention findings, PR-review findings. Before issue
 * #178 that scale was authored three times — `FindingSeveritySchema` (insight),
 * `ReviewSeveritySchema` (pr-review), and a hand-written union in the web's
 * `lib/severity.ts` — three declarations no test tied together, so a new level
 * (or a renamed one) could land on one and silently not the others.
 *
 * This module is the single declaration. The per-family names remain as ALIASES of
 * it (`FindingSeveritySchema`, `ReviewSeveritySchema`) so every existing import,
 * docstring, and generated-Rust reference keeps working — the point is one
 * value-set, not a rename. The web derives its display order and badge palette from
 * {@link SeveritySchema}`.options` rather than restating the members.
 *
 * Ordered low→high, which is also the codegen-relevant order: the emitter keys Rust
 * enums by their value-set signature (`info|low|medium|high|critical` →
 * `FindingSeverity`), so collapsing the two zod declarations into one leaves
 * `generated.rs` byte-identical.
 *
 * Zod-only, imports nothing: a leaf every feature file can import without a cycle.
 */
export const SeveritySchema = z.enum([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);
export type Severity = z.infer<typeof SeveritySchema>;
