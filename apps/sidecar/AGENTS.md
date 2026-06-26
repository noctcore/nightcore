# apps/sidecar — Agent Contract

The Bun sidecar stays deliberately dumb: it is a protocol relay, nothing more.

- It parses exactly one `SurfaceCommand` per stdin line into `SessionManager` and streams exactly one `NightcoreEvent` per stdout line. It validates with `@nightcore/contracts` `safeParse` at each hop and forwards — never trusting raw input — and drains logs.
- NO orchestration logic may live here: no task registry, auto-loop, concurrency control, worktree management, dependency ordering. ALL orchestration lives in the Rust core (`apps/desktop/src-tauri`). If you are tempted to add coordination logic to the sidecar, it belongs in the core.
- The SDK is reached only through `@nightcore/engine`; never import `@anthropic-ai/claude-agent-sdk` here.
- Tests use `bun:test` with `/// <reference types="bun" />` and inject a scripted fake `query()` — no live SDK call ever runs.