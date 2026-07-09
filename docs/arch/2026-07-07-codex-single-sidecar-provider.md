# Codex Provider Runs Inside the Existing Bun Sidecar

**Date:** 2026-07-07
**Lens:** Provider architecture / packaging
**Scope:** Desktop runtime provider swap point for Claude and Codex
**Baseline:** Issue #18 established a neutral `AgentProvider` seam and a degraded Codex spike; issue #79 makes Codex real through `@openai/codex-sdk`.

## Decision

Codex is an engine-side provider implementation inside the existing Bun sidecar, selected by the same `NIGHTCORE_PROVIDER` / engine provider factory path as Claude.

Nightcore does not add a second `externalBin`, provider-specific Rust sidecar process, or sidecar-by-architecture packaging matrix for Codex.

## Rationale

The existing desktop transport is already provider-neutral: Rust sends `SurfaceCommand` / `SurfaceQuery` NDJSON to one long-lived Bun bridge, and the engine owns the provider factory behind that bridge. `@openai/codex-sdk` follows the same architectural shape as the Claude SDK from Nightcore's perspective: a TypeScript client spawns a provider CLI subprocess per session and streams typed events.

The swap point remains `packages/engine/src/providers/provider-factory.ts`; Rust stays on the stable provider transport and capability query seams. This preserves the single bundled sidecar artifact and keeps provider-specific SDK semantics out of the Rust core and web surface.

## Supersedes

This supersedes the earlier design prose that each provider must be a separate sidecar binary speaking the same NDJSON protocol. That remains a possible future escape hatch for a provider that cannot run inside the engine process, but it is no longer the default provider architecture.
