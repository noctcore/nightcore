# Spike — Worker isolation for `SessionRunner`

**Date:** 2026-06-21
**Status:** Resolved — **recommendation: stay in-process for now.** Revisit only
under the specific condition in §6.
**Source comment:** `packages/engine/src/session-manager.ts` (`// SPIKE:` block)
and `docs/architecture.md` → "Deferred spikes".

---

## 1. The question

Should `SessionRunner` run in-process (today's design) or move to a
`worker_thread` / child-process boundary per session?

The concern is **double-subprocessing**: the Claude Agent SDK *already* spawns
its own OS subprocess (the bundled Claude Code CLI). Wrapping each runner in a
second worker thread/process would mean:

```
Nightcore main process
  └─ worker_thread / child_process   ← the proposed extra boundary
        └─ SDK query()
              └─ child_process.spawn('claude', …)   ← the SDK's own CLI subprocess (real work)
```

The model's tokens, tools, file I/O, and CPU all execute inside that bottom CLI
subprocess — **not** in Nightcore's JS at all.

## 2. What the code actually does today

Verified from source:

- `SessionManager.startSession` constructs a `SessionRunner` in-process and calls
  `void runner.run().finally(() => this.retire(id))` — fire-and-forget, no thread
  boundary (`session-manager.ts:117-149`).
- `SessionRunner.run()` is an `async` `for await` loop over the SDK's
  `AsyncGenerator<SDKMessage>`. Each message is run through the **pure,
  synchronous** `translateMessage` and emitted (`session-runner.ts:96-114`).
- The SDK boundary itself: `@anthropic-ai/claude-agent-sdk` uses
  `child_process.spawn` (confirmed: 5 `child_process` refs, 2 `spawn(` calls in
  `sdk.mjs`) to launch a **216 MB native `claude` binary** shipped as a
  per-platform optional dependency (`@anthropic-ai/claude-agent-sdk-darwin-arm64`
  etc.). The heavy lifting is out-of-process already.

So per live session the real topology is **already** `main JS ↔ 1 OS subprocess`.
The runner's in-process JS work is purely: pump an async iterator, run a small
pure mapper, emit events on an `EventEmitter`.

## 3. Crash isolation — how much does in-process actually cost us?

| Failure mode | In-process today | With a worker boundary |
|---|---|---|
| SDK CLI subprocess crashes / exits non-zero | The `for await` loop throws → caught in `run()`'s `try/catch` → `handleCrash` emits `session-failed` (reason `runner-crash`), `closeInput()`, `failAllPending()`. **Other sessions untouched.** (`session-runner.ts:109-114, 173-184`) | Same, plus the worker dies. No added safety — the crash was already contained by try/catch. |
| SDK throws a JS exception mid-iteration | Same try/catch path. Contained. | Same. |
| Runner code throws synchronously (our bug) | Caught by the same `try/catch`; degrades to `session-failed`. | Worker isolates a *segfault-class* fault, which JS effectively cannot produce here (no native addons in the runner). |
| Unhandled promise rejection / `process.exit` inside our JS | Would take the whole process down. | A worker boundary **would** contain this. |

**Key finding:** the only failure class a worker boundary adds protection
against is a hard native crash or a rogue `process.exit()` *inside Nightcore's
own JS* — and the runner has **no native code** and does **no `process.exit`**.
The genuinely crash-prone component (the model CLI) is *already* in its own OS
process, and its failures are already caught and degraded. The marginal crash-
isolation value of a second boundary today is ~nil.

## 4. Shared event-loop blocking

The realistic in-process risk is **event-loop starvation**, not crashes: if one
session does heavy *synchronous* JS work, it stalls every other session and the
surface.

Audit of the per-message in-process work (`translateMessage` + emit):
- `translateMessage` is `O(blocks)` over a single message, pure, allocation-light,
  no JSON parse of large payloads, no sync FS. Cheap.
- `SessionStore.save` does a **synchronous** `fs.appendFileSync` on terminal
  events (`storage/src/index.ts:31-40`). This is the one sync-I/O point. It runs
  once per session lifecycle transition (ready/completed/failed), not per token,
  and writes one short JSONL line — negligible, but it *is* the first thing to
  watch if session counts grow large.

There is no per-token synchronous hot path in Nightcore JS. Streaming deltas
arrive already-chunked from the CLI subprocess; we just forward them. So one
"hung" session does **not** block others in-process — a hang manifests as that
session's async iterator simply not yielding, which parks only that session's
microtask chain, not the loop.

## 5. Memory & overhead of moving to workers

- Each `worker_thread` carries its own V8 isolate (~a few MB baseline) **plus** a
  duplicated module graph (contracts/zod/the SDK shim). A `child_process` is even
  heavier. Multiply by N concurrent sessions.
- It also forces **serialization** of the `NightcoreEvent` stream across the
  boundary (structured-clone / postMessage), turning today's zero-copy in-process
  `EventEmitter` into a marshalling cost on every event — including high-frequency
  partial `assistant-delta`s. That is a real, per-token tax that the current
  design avoids entirely.
- Net: a worker boundary **adds** memory and per-event latency to buy crash
  isolation we established (§3) is essentially unnecessary today.

## 6. Recommendation

**Stay in-process.** It is the correct call for the foundation:

1. The crash-prone work is already isolated in the SDK's own 216 MB CLI
   subprocess; its failures are already caught and degraded to `session-failed`.
2. The runner does no native work and no synchronous per-token work, so it cannot
   meaningfully starve the shared event loop.
3. A worker boundary would add V8-isolate memory per session and a
   structured-clone tax on every event (worst on streamed deltas) for negligible
   isolation gain.
4. The "double-subprocess" instinct is correct: a second boundary is redundant
   with the SDK's existing one.

**Move to a per-session boundary later only if `condition X` holds:**

> **Condition X** — Nightcore starts doing **heavy synchronous CPU work per
> message inside its own JS** (e.g. local re-tokenisation, syntax highlighting of
> large tool outputs on the main thread, in-process embeddings/search over
> transcripts, or bundling a *native addon* into the runner). At that point the
> event-loop-starvation risk (§4) becomes real and a `worker_thread` per session
> — or, better, a single shared worker pool for the CPU work rather than one
> worker per session — is justified.

A secondary, weaker trigger: if Nightcore ever runs **untrusted** session code in
its own JS (it does not today — all untrusted execution is inside the CLI
subprocess sandbox), a hard process boundary would become a security control, not
just a performance one.

Until then, the `// SPIKE:` comment can be downgraded to a `// NOTE:` pointing at
this doc, and the in-process design kept.

## 7. Cheap guardrails to add now (no architecture change)

These keep the in-process design healthy and make a future move easier:

- **Bound concurrency.** Add a max-live-sessions cap in `SessionManager` so a
  burst of `start-session` commands cannot fan out unbounded CLI subprocesses
  (each is 216 MB-class). Today `activeCount` is observable but unbounded.
- **Per-session timeout/watchdog.** A session whose iterator never yields and is
  never interrupted lives forever. A wall-clock watchdog that calls
  `runner.interrupt()` would bound the failure. (The plumbing — `AbortController`
  + `interrupt()` — already exists in `session-runner.ts`.)
- **Keep `translateMessage` pure and allocation-light** (it is today) so the
  in-process assumption in §4 stays valid; guard it with the adapter unit tests.

> No engine source was modified for this spike. The guardrails above are
> recommendations for a follow-up task, not changes made here.
