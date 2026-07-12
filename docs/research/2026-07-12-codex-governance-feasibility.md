# Research: Is porting PreToolUse-style governance to Codex feasible?

**Date:** 2026-07-12
**Agent:** kirei-research
**Status:** complete
**Scope:** GitHub issue #296 item 2 (governance/ledger gap) — decision record for whether the Codex path stays fail-closed-refuse or graduates to enforcement.

## Problem

Claude-backed tasks enforce Harness governance policy (protected paths + Bash-deny
patterns) and write a flight-recorder audit ledger by intercepting every SDK tool
call via the Claude Agent SDK's `PreToolUse` hook. Codex-backed tasks have no
equivalent — a Codex session silently runs ungoverned and unaudited. The maintainer
wants to know whether `@openai/codex-sdk` / the Codex CLI itself exposes a genuine
tool-interception seam this could be ported onto, before accepting "fail-closed
refuse" as the durable answer for #296.

## VERDICT: PARTIAL (moderate-high confidence)

A real, synchronous, pre-execution interception seam **does exist in the Codex
stack** — but not in the SDK Nightcore currently drives, and not with parity to
Claude's `PreToolUse`. Two independent facts combine into "PARTIAL, not FEASIBLE":

1. **The npm package Nightcore actually uses (`@openai/codex-sdk`, driving
   `Thread.runStreamed()`/`codex exec`) has ZERO interception surface.** It spawns
   `codex exec --experimental-json` as a one-shot subprocess, writes the prompt to
   stdin, **closes stdin immediately**, and only reads a JSONL event stream back.
   There is no callback, no request/response channel, nothing to answer
   synchronously. Nightcore's own code already documents this exact conclusion (see
   Evidence). This is why every Codex posture today sets `approvalPolicy: 'never'`.

2. **A genuine seam exists one layer down, in `codex app-server --stdio`** (the
   Rust CLI's bidirectional JSON-RPC protocol — a *different* invocation mode than
   `codex exec`, not currently used by Nightcore for turn-driving). Under an
   approval policy other than `never` (e.g. `untrusted`), the app-server issues
   `execCommandApproval` (before a shell command runs) and `applyPatchApproval`
   (before a file patch is applied) requests **to the client**, which must reply
   `{ decision: "allow" | "deny" }` before the action proceeds. This is a real,
   synchronous, pre-execution block point — the actual Codex-side analog of
   `PreToolUse`.

   But it is **narrower and leakier** than Claude's hook, by design of the
   underlying CLI, not by any Nightcore choice:
   - Even under the most aggressive `untrusted` policy, the codex-rs binary's own
     baked-in "trusted command" classifier auto-runs commands it judges safe
     (read-only-ish operations) **without ever emitting an approval request** —
     confirmed via OpenAI's own docs: "`untrusted` policy ... runs only known-safe
     read operations automatically ... commands that can mutate state ... require
     approval." Nightcore cannot inspect or override that classifier from the
     app-server client. Claude's `PreToolUse`, by contrast, has zero such
     exceptions — literally every tool call passes through it.
   - The documented approval surface covers exactly two item types —
     `command_execution` and `file_change` (patches) — with **no approval event
     for MCP tool calls**. Harness policy's `disallowedTools`/`askTools` tiers,
     which gate arbitrary `mcp__server__*` entries (module #9), have **no seam at
     all** under Codex, under any policy.
   - To reach this seam, Nightcore would have to abandon the officially
     maintained, versioned `@openai/codex-sdk` package for turn-driving and
     hand-roll its own JSON-RPC client against `codex app-server`, a protocol
     the upstream repo documents as **"experimental — method names, fields, and
     event shapes may evolve,"** with no published TypeScript types. That is a
     rewrite of the entire Codex turn-driving stack, not a localized addition.

## Evidence

### How Claude does it (the bar to match)
- `packages/engine/src/providers/claude/hook-bus.ts:130-198` — `HookBus.decidePreToolUse()`
  fires on **every** SDK tool call (`tool_name`/`tool_input`, before execution) and
  evaluates, in order: (1) destructive-command deny list, (2) workspace confinement,
  (3) the project's Harness policy (protected paths, Bash deny patterns, tool
  deny/ask tiers — `packages/engine/src/policy/harness-policy.ts:445-542`), (4) the
  exec-sink ask gate. Returns `permissionDecision: 'deny'|'ask'` synchronously, and
  fires **regardless of `permissionMode`** — including `bypassPermissions`
  (`hook-bus.ts:32-47`).
- `packages/engine/src/policy/harness-policy.ts:133-138,487-539` — the policy is
  keyed on Claude's specific SDK tool taxonomy (`Write`/`Edit`/`MultiEdit`/
  `NotebookEdit` for mutation-path checks, `Read`/`NotebookRead`/`Grep`/`Glob` for
  read-denial, `Bash` for command-pattern denial, plus arbitrary
  `disallowedTools`/`askTools` including `mcp__server__*` globs).
- `packages/engine/src/session/session-ledger.ts:69-75,144-156` — the audit record
  the ledger needs per call: `{ ts, tool, inputDigest, decision, ruleId? }`, fed
  from the *same* `HookBus.onToolDecision` seam every gate evaluation passes
  through (`session-runner.ts:162-179`, `SessionLedger` is provider-neutral — it
  lives in `packages/engine/src/session/`, not `providers/claude/`).

### Codex's current integration (zero interception)
- `packages/engine/src/providers/codex/codex-agent-provider.ts:126-233` —
  `CodexSession.run()` drives `Thread.runStreamed()` from `@openai/codex-sdk`; grep
  confirms zero references to `this.params.harnessPolicy` / `this.params.ledgerPath`
  anywhere in the file.
- `node_modules/@openai/codex-sdk/dist/index.js:250-261` — `CodexExec.run()`:
  `child.stdin.write(args.input); child.stdin.end();` — stdin is closed the instant
  the prompt is sent. No callback exists in the SDK for anything asked mid-turn.
- `node_modules/@openai/codex-sdk/dist/index.d.ts:167-172,235-250` — `TurnOptions`
  has exactly `{ outputSchema?, signal? }`; `ApprovalMode = "never" | "on-request" |
  "on-failure" | "untrusted"` exists on `ThreadOptions.approvalPolicy` but is only
  ever serialized into a static `--config approval_policy="..."` CLI flag
  (`index.js:220-222`) — a mode passed *into* the subprocess, not a channel for
  answering anything back.
- `packages/engine/src/providers/codex/options.ts:35-48` — Nightcore's own
  `codexPostureForAutonomy()` docblock, verbatim: *"THE DEADLOCK INVARIANT: the
  codex-sdk ... runs each turn as a non-interactive `codex exec` — it writes the
  prompt to stdin, CLOSES stdin, and exposes NO approval callback and no approval
  event in its `ThreadEvent` stream. So any `approval_policy` that can raise an
  approval request ... has no channel to answer it ... We therefore NEVER emit
  those policies here — every posture uses `never`."* This is the same conclusion
  this research independently reaches from the SDK source — Nightcore's engineers
  already diagnosed this correctly.

### The real seam: `codex app-server` (not currently used for turns)
- `packages/engine/src/providers/codex/model-catalog.ts:149-243` — Nightcore
  **already** spawns `codex app-server --stdio` and speaks its JSON-RPC over
  stdin/stdout for exactly one method today (`model/list`), proving the protocol is
  reachable from the sidecar process and that Nightcore has prior art for driving it
  (`initialize` → response-keyed dispatch on `parsed.id`).
- Per upstream docs (`codex-rs/app-server/README.md`, `codex-rs/docs/codex_mcp_interface.md`,
  cross-confirmed by promptfoo's provider docs): `thread/start`/`thread/resume`
  begin a conversation, `turn/start` runs a turn and streams `turn/started`,
  `item/started`, `item/completed`, `turn/completed` notifications — a full
  parallel turn-driving surface to what `@openai/codex-sdk` gives via `codex exec`.
  When `approvalPolicy` isn't `never`, the server sends the client
  `execCommandApproval` (`conversationId`, `callId`, `command`, `cwd`, `reason`) and
  `applyPatchApproval` (`conversationId`, `callId`, `fileChanges`, `reason`) as
  **JSON-RPC requests the client must answer** with `{ decision: "allow" | "deny" }`
  before the action proceeds — genuinely synchronous, pre-execution, blocking.
  Upstream flags the whole interface **"experimental. Method names, fields, and
  event shapes may evolve."**
- OpenAI's own approvals docs (`developers.openai.com/codex/agent-approvals-security`):
  under `untrusted`, "Codex runs only known-safe read operations automatically...
  commands that can mutate state or trigger external execution paths... require
  approval" — i.e., even the strictest policy has a built-in, client-invisible
  bypass for what the CLI judges "trusted." Sandbox containment (file/network
  access) is enforced separately, at the OS level, by `sandboxMode` — independent
  of approvals.

### Where Codex's own sandbox already covers part of the intent
- `packages/engine/src/providers/codex/capabilities.ts` declares
  `providesOwnWriteContainment: true` — `sandboxMode: 'workspace-write'` already
  kernel-confines writes to the working directory (+ `additionalDirectories`),
  which substantially overlaps with `HookBus`'s workspace-confinement gate
  (`hook-bus.ts:151-160`). What has **no** Codex-native analog at all is the
  *project-custom* half of Harness policy — arbitrary `protectedPaths` (e.g.
  `package-lock.json`, `migrations/**`) and `denyBashPatterns` (e.g. `--no-verify`)
  — since the kernel sandbox only knows "inside workspace" vs. "outside," not a
  project's declared semantic rules.
- `packages/engine/src/providers/codex/options.ts:100-120` — `review` is already
  pinned to the `plan` (kernel read-only) sandbox regardless of resolved autonomy,
  so the highest-value case (a reviewer that must never write) is already provably
  contained today without needing this seam at all.

## Solution Options

### Option A — Stay fail-closed refuse (current #296 posture)
Keep `AutonomyNotPermittedError` for `bypass` and rely on `assertHooksInvariant`
(`packages/engine/src/providers/agent-provider.ts:204-225`) plus Codex's own
sandbox for `auto-accept`/`plan`. No enforcement of project-custom protected
paths/Bash-deny patterns or ledger writes for Codex, ever.
- Pro: zero engineering risk, zero new maintenance surface, matches the existing,
  already-reasoned "deadlock invariant" analysis in the codebase.
- Con: Codex tasks remain permanently ungoverned/unaudited on the two axes
  (project-custom protected paths, Bash-deny patterns) that Codex's own sandbox
  doesn't cover; leaves #296 item 2 open indefinitely.

### Option B — Build a second Codex turn-driver on `codex app-server --stdio`
Replace `CodexSession.run()`'s use of `@openai/codex-sdk`'s `Thread.runStreamed()`
with a hand-rolled JSON-RPC client speaking `thread/start`/`turn/start` etc., set
`approvalPolicy: 'untrusted'` (or `on-request`) instead of the current hardcoded
`'never'`, and answer `execCommandApproval`/`applyPatchApproval` requests by
re-evaluating the SAME provider-neutral policy functions Claude already uses
(`evaluateHarnessPolicy`, `evaluateToolDeny` from `packages/engine/src/policy/`),
mapping `execCommandApproval.command` → a synthetic `Bash` tool call and
`applyPatchApproval.fileChanges[].path` → synthetic `Write`-shaped calls per
changed file, feeding the SAME `SessionLedger.recordToolDecision` Claude uses.
- Pro: real, synchronous, pre-execution enforcement + full audit trail for the two
  axes Harness policy actually cares about (Bash deny patterns, protected file
  paths); reuses all of Nightcore's existing policy-evaluation code untouched
  (it's already provider-neutral, keyed on `(toolName, toolInput)` strings, not SDK
  types) — only a new adapter layer is needed, not new policy logic.
- Con: **large** rewrite of the Codex session stack (thread lifecycle, turn
  lifecycle via `turn/start`/`turn/interrupt` replacing today's `AbortController`,
  event translation for a different event vocabulary, `streamInput`/follow-up
  semantics) against a protocol upstream explicitly calls experimental and
  unversioned in the npm sense — trades a maintained SDK dependency for a
  hand-maintained client pinned to whatever `codex` binary is installed. Coverage
  gaps remain even after the work: the CLI's own "trusted command" bypass (some
  commands never generate an approval request — no gate, no ledger record) and no
  seam at all for MCP tool calls (`disallowedTools`/`askTools` mcp entries stay
  unenforceable under Codex regardless).

### Option C — Declare the gap instead of closing it (minimum viable #296 fix)
Add `supportsHarnessPolicy`/`supportsLedger`-style flags to `ProviderCapabilities`
(`packages/contracts/src/provider.ts`), surface a UI banner/`unsupported`
`ProviderConfigSection` when a Codex task has an active `.nightcore/harness.json`
policy, and keep the current fail-closed-refuse behavior for `bypass`. This is the
provider-coupling audit's own advisory fix for finding #2
(`docs/research/2026-07-12-provider-coupling-audit.md:391`).
- Pro: small, fast, closes the "silent" part of the gap (no more invisible
  governance loss) without committing to the Option B rewrite or its experimental-
  protocol risk.
- Con: doesn't add any actual enforcement — a Codex task with `auto-accept` can
  still write to a `protectedPaths` file or run a `denyBashPatterns`-matched
  command with no block and no audit record; only makes that fact visible.

## Recommended Approach

**Option C now, Option B as a scoped, separately-evaluated follow-up — not
Option A as a permanent stance.** The research does not support "wait for OpenAI to
ship a feature" as the closing rationale: the interception primitive already
exists in the Codex stack today (`app-server`'s approval RPCs), so "fail-closed
refuse" should be described as a *deliberate scope decision given the rewrite cost
and protocol-stability risk*, not an SDK limitation with no path forward. Ship
Option C immediately (cheap, closes the "silent" complaint in #296 item 2's own
wording). Treat Option B as a real, buildable project — reusing 100% of the
existing policy-evaluation code — but scope it as its own initiative with an
explicit spike step (see Open Questions) given the size and the experimental-
protocol risk, not as a quick addition to #296.

## Files to Modify (if Option C is taken now)

- `packages/contracts/src/provider.ts` — add `supportsHarnessPolicy: boolean` /
  `supportsLedger: boolean` (or a combined `supportsToolGovernance`) to
  `ProviderCapabilitiesSchema`.
- `packages/engine/src/providers/claude/capabilities.ts` — set the new flag(s)
  `true`.
- `packages/engine/src/providers/codex/capabilities.ts` — set the new flag(s)
  `false`, honestly declared alongside the existing `supportsHooks: false`.
- `packages/engine/src/providers/codex/codex-agent-provider.ts` (`CodexSession`) —
  when `params.harnessPolicy` is present and non-empty, surface an
  `unsupported`/warning signal (mirrors the existing `probeConfig()` pattern at
  `:320-352`) rather than silently dropping it.
- `apps/web` capability-consuming UI (wherever `supportsHooks`-style flags already
  gate affordances, e.g. `NewTaskForm.hooks.ts`) — add a banner/notice when a
  project has an armed Harness policy and the selected provider is Codex.

## Files to Modify (if Option B is later greenlit — NOT now)

- `packages/engine/src/providers/codex/sdk-adapter.ts` — new event-translation
  layer for `app-server`'s `turn/*`/`item/*` notification vocabulary (distinct from
  today's `ThreadEvent` union, which is `codex exec`-specific).
- `packages/engine/src/providers/codex/codex-agent-provider.ts` — new
  `CodexThreadLike`-equivalent driven by JSON-RPC request/response instead of
  `Thread.runStreamed()`; `interrupt()` becomes `turn/interrupt` instead of
  `AbortController.abort()`.
- A new `packages/engine/src/providers/codex/hook-bus.ts`-equivalent (or a shared,
  provider-neutral adapter in `packages/engine/src/policy/`) that maps
  `execCommandApproval`/`applyPatchApproval` requests onto
  `evaluateHarnessPolicy`/`evaluateToolDeny`/`evaluateExecSinkGate` calls and
  `SessionLedger.recordToolDecision`.
- `packages/engine/src/providers/codex/options.ts` — `codexPostureForAutonomy()`'s
  hardcoded `approvalPolicy: 'never'` everywhere would need to change to
  `'untrusted'` for postures where enforcement is desired, with the "DEADLOCK
  INVARIANT" docblock rewritten to describe the new answerable channel.

## Reference Files (do not modify)

- `packages/engine/src/providers/claude/hook-bus.ts` — the parity bar; also the
  best template for how a Codex-side adapter should be structured (observe →
  evaluate tiers in order → deny/ask/allow → record).
- `packages/engine/src/policy/harness-policy.ts`,
  `packages/engine/src/policy/tool-deny-policy.ts`,
  `packages/engine/src/policy/exec-sink.ts`,
  `packages/engine/src/policy/workspace-confinement.ts` — already provider-neutral
  (`(toolName: string, toolInput: unknown)` in, verdict out); reusable as-is by any
  future Codex adapter.
- `packages/engine/src/session/session-ledger.ts` — already provider-neutral;
  reusable as-is.
- `packages/engine/src/providers/codex/model-catalog.ts:149-243` — existing prior
  art for spawning and speaking JSON-RPC to `codex app-server --stdio` from
  Nightcore's own process.
- `docs/research/2026-07-12-provider-coupling-audit.md` §4.5, §7 finding #2 — the
  audit this research extends; its Option C recommendation and file pointers are
  reused verbatim above.

## Risks & Gotchas

- **Protocol instability.** `codex app-server`'s method/event shapes are
  upstream-documented as experimental and can change between Codex CLI releases;
  any Option B build needs a version-pinning/compat story (Nightcore already pins
  `@openai/codex-sdk@0.142.5` in `packages/engine/package.json` — the app-server
  binary ships in the same release train via `@openai/codex`, so the two stay in
  lockstep, but the RPC schema itself has no independent semver guarantee the way
  the npm SDK's `.d.ts` does).
- **Coverage gaps survive even a full Option B build.** The CLI's own "trusted
  command" classifier and the complete absence of an MCP-tool-call approval event
  mean Option B can **never** reach full parity with Claude's `PreToolUse` — this
  should be stated explicitly in any future spec so nobody re-litigates "why
  doesn't this behave exactly like Claude."
- **`untrusted` policy behavior change is itself a UX risk**, independent of the
  governance question: switching Codex from `approvalPolicy: 'never'` to
  `'untrusted'` for enforcement changes what happens on a sandbox-denied command
  from "fails visibly, model adapts" (today's documented, deliberate posture per
  `options.ts:41-47`) to "an approval round-trip the app must answer
  programmatically" — needs its own deadlock-avoidance analysis (this research
  only establishes the seam exists and is answerable *by Nightcore's own process*
  synchronously; it does not analyze turn-loop timing/latency effects of adding a
  request/response round trip to every gated command).
- **Do not conflate this with `assertHooksInvariant`.** That gate is about the
  `bypass`/`auto-accept` OS-containment invariant and is correctly enforced today
  regardless of this research's outcome; Option B would be an *additional* layer
  on top, not a replacement for it.

## How to Verify

This is a research-only deliverable; there is no code change to verify. To
validate the core technical claim before committing to Option B, run a scoped spike:
1. Spawn `codex app-server --stdio` (as `model-catalog.ts` already does) with a
   `newConversation`/`thread/start` + `turn/start` sequence, `approvalPolicy:
   "untrusted"`, on a task that both runs a shell command and asks the agent to
   edit a file.
2. Confirm `execCommandApproval`/`applyPatchApproval` requests are actually
   received (not `on-request`/`on-failure` semantics misread) and that replying
   `{ decision: "deny" }` genuinely blocks the action rather than degrading to a
   soft warning.
3. Confirm a plain `cat`/`ls`-style read command does or does not trigger a
   request under `untrusted` (validates the "trusted command bypass" claim
   directly against the installed CLI version rather than third-party docs).

## Open Questions

- Exact current wire schema of `execCommandApproval`/`applyPatchApproval` (field
  names, whether `turn/start` or `thread/start` carries `approvalPolicy`, whether a
  newer `item/commandExecution/requestApproval` flow has superseded the legacy
  pair) was cross-confirmed from three independent secondary sources (GitHub
  README, a third-party protocol guide, promptfoo's provider docs) but **not**
  verified against a live `codex app-server --stdio` session in this pass — the
  spike in "How to Verify" should be the actual gate before any Option B spec is
  written, not this document.
  - **Note:** Ref MCP had no indexed documentation for `@openai/codex-sdk` or the
    `codex app-server` protocol at the time of this research; findings rely on
    WebSearch/WebFetch of GitHub + OpenAI's own docs + third-party write-ups,
    cross-checked against the installed package's actual source
    (`node_modules/@openai/codex-sdk/dist/index.js`).
- Whether OpenAI has (or would accept) a feature request for the *npm SDK* itself
  to expose an approval callback on `Thread.runStreamed()` (i.e., first-class
  support for what `app-server` already does at the protocol level) — this would
  eliminate the "abandon the versioned SDK" cost of Option B entirely. Not
  researched here; worth a GitHub issue against `openai/codex` before greenlighting
  Option B, since it could turn Option B from "hand-roll a JSON-RPC client" into
  "pass a callback."
- Whether `sandboxMode: 'workspace-write'` already exposes a config knob (e.g. a
  denylist of writable sub-paths) that could cover the `protectedPaths` axis at the
  *sandbox* level instead of the approval-request level — briefly touched on via
  `CodexOptions.config`'s free-form `--config key=value` passthrough
  (`options.ts:161-172` already uses this for `mcp_servers`) but not exhaustively
  checked against `codex-rs`'s config schema for a `sandbox_workspace_write.*`
  path-exclusion option. If one exists, it could deliver protected-path
  enforcement WITHOUT the Option B rewrite (kernel-level, no approval round-trip at
  all) — worth checking before scoping Option B's effort.
