# @nightcore/contracts — Agent Contract

This package is the single source of truth at the sidecar boundary and the dependency-graph leaf: it depends on `zod` only (plus leaf utils). Every wire message is validated against a schema at each hop and never trusted raw.

## Schema authoring
- Every exported zod schema is a PascalCase const suffixed `Schema`, paired with a same-named inferred type. Do NOT hand-author a duplicate type:
  ```ts
  export const FooSchema = z.object({ /* ... */ });
  export type Foo = z.infer<typeof FooSchema>;
  ```
  Convention checked by `nightcore/zod-schema-naming` (registered but currently advisory/`off`, not wired to `error`): discriminated-union *member* schemas below use role suffixes (`Command`/`Event`/`Query`), not `Schema`, so enforcing the suffix repo-wide would mis-flag them.
- Message schemas are named `<Noun><PastVerb>Event` / `<Verb><Noun>Command` / `<Verb><Noun>Query`. The wire `type` discriminant is a kebab-case literal equal to the const name minus its role suffix (e.g. `SessionFailedEvent` → `type: 'session-failed'`).
- Wire field names are camelCase. Any SDK snake_case field crossing the boundary is renamed to camelCase in the zod schema.
- Enum string-value casing tracks the source of truth: wire `type` discriminants → kebab-case; SDK-mirrored enums → copy the SDK casing verbatim (note it in a comment); Rust-shared enums → snake_case/lowercase matching the serde mapping. Add the rationale as a comment so the choice isn't re-guessed.

## Additive evolution — never break legacy data
- New fields on persisted/serialized schemas are optional with an absent default, added in their own additive block, plus a field-absent pinning test. Never add a breaking required field.

## Codegen — regenerate, never edit
- The core↔sidecar wire types are code-generated both directions. Add the field to the zod schema first, then run `bun run codegen:contracts` (zod→Rust) and `cargo test` (Rust serde→web TS via ts-rs). Generated outputs (`apps/desktop/src-tauri/src/contracts/generated.rs`, `apps/web/src/lib/generated/**`) are one-type-per-file and MUST NEVER be hand-edited. `tools/lint-meta` fails CI when committed codegen drifts from this source.