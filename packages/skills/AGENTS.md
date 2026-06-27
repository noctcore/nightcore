# @nightcore/skills — Agent Contract

Read this before editing. These are hard guardrails, enforced by `bun run lint`, `bun run test:all`, and `tools/lint-meta`. Severity is **error or off, never warn** — a rule that matters is an error; fix the failure, do not silence it.

## Layer position (enforced by `layer-rank`)
- `@nightcore/skills` is a CAPABILITY package (rank 3 in the spine `contracts → shared → storage/skills → engine → surfaces`; storage and skills are co-tier).
- NEVER import `@nightcore/engine`. The engine pulls capabilities in (dependency inversion), never the reverse — enforced by `no-restricted-imports` in the root config AND by `layer-rank`.
- NEVER add `@anthropic-ai/claude-agent-sdk` as a dependency. Re-declare the SDK agent shape STRUCTURALLY (SDK-free): add new agent-preset fields to `SkillDefinition`; the single seam mapping it to the real `AgentDefinition` (`toAgentDefinition` / `agent-presets.ts`) lives in the engine, not here.
- Cross-package imports use the `@nightcore/<pkg>` barrel only (`nightcore/no-deep-package-imports`). Every `@nightcore/*` import must be a declared `workspace:*` dep mirrored in `tsconfig` references (`workspace-graph-parity`).

## Read-only personas
- A preset described as read-only MUST be backed by (1) `disallowedTools` covering the full write/exec set, (2) a non-prompting `permissionMode`, and (3) a preset test asserting denial. Prose never enforces read-only.
- Context is layered: stable identity in the preset; per-run instructions are appended by the caller, never inlined into the preset persona.

## Tests
- Use `bun:test` with `/// <reference types="bun" />` as the first line; never Vitest (`test-runner-segregation`).
- This package must be enrolled in the root `test:node` script once it has tests (`test-workspace-enrollment`); the real gate is `bun run test:all`.
