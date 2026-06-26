# @nightcore/engine — Agent Contract

The engine is the ONLY package allowed to depend on the Claude Agent SDK, and the façade every surface reaches the model through.

## SDK containment
- Runtime/value use of `@anthropic-ai/claude-agent-sdk` (the `query()` runtime) lives ONLY in `src/sdk-adapter.ts`. Type-only `import type` of SDK shapes is allowed in engine internals (e.g. `permission-layer.ts`, `question-layer.ts`, `hook-bus.ts`); never add a value/runtime SDK import outside `sdk-adapter.ts`. Surfaces and capability packages stay fully SDK-free and reach the model through the engine façade.
- Capability packages (`packages/skills`, peers) are pulled in by the engine via dependency inversion; the engine imports them, never the reverse.

## Session semantics — degrade, don't throw
- `SessionManager`/`SessionRunner` surface failures as `session-failed` events. `run()` MUST translate errors into events and return — it must never reject.
- Session ids are monotonic and single-use: late events from a torn-down runner are dropped, and a session id is never reused. Numeric Nightcore id is `sessionId` (number); the SDK UUID is `sdkSessionId` (string) — never name an SDK UUID `sessionId`.

## Agent presets
- An agent's stable identity (persona, toolset, permission mode) lives in an engine preset and is injected via `appendSystemPrompt`/`Options`; per-run instructions are appended by the caller, never inlined into preset persona text.
- Built-in agent presets ride `Options.agents` so they survive strict isolation; `settingSources` is purely the ambient-context (skills/commands/CLAUDE.md) loader and an empty list means strict isolation.
- A read-only persona MUST be backed by `disallowedTools` covering all write/exec tools AND a non-prompting permission mode — prose alone never enforces read-only. Add a test asserting read-only presets deny the write-tool set.
- Preset tool lists use native SDK tool names (Read/Glob/Grep/Write/Edit/Bash), never the removed `mcp__nightcore__*` tools.
- Prompts and machine-output contracts are authored as fragment arrays joined with `.join(' ')` (prose) or `.join('\n')` (structured), not free-form template literals.

## Secrets
- Values that may carry secrets in agent context (`Options.mcpServers` `env`/`headers`, resume/session ids) are logged at `logger.debug` only — never at info/telemetry.

## Testing
- Engine/sidecar tests inject a scripted fake `query()` and mock the session-store FS functions. No test reaches the real SDK or `~/.claude`.