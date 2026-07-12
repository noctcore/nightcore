# Platform-primitives adoption spike (T12 / #153) — decision memo

**Scope:** decide whether Nightcore should adopt the Claude Code / Agent SDK
**native sandbox primitives** in place of its custom Seatbelt writers — covers BOTH
`sandbox.ts` (agent-write confinement, §1/§3–§7/D3/D4) and `confine.rs` (the
confined-terminal profile, §1b) — and produce a migration plan + the two user-facing
decisions (D3, D4). Feeds the execution ticket **T16 / #157** (native-sandbox
adoption) and the review-calibration build **#197** (structured outputs). Read
alongside the roadmap `2026-07-11-roadmap-v0.3-v0.5.md` §2.3, §5.4, §6, §8.

Grounding is by `file:line` and by primary-source doc citation. The pinned SDK is
`@anthropic-ai/claude-agent-sdk@0.3.190` (`packages/engine/package.json:15`); latest
published is `0.3.207`. The authoritative sandbox behavior is the shipped SDK
`sandbox` schema (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2639-2692`)
cross-checked against the current docs (`code.claude.com/docs/en/sandboxing`,
fetched 2026-07-12). Companion doc: `docs/research/2026-07-12-codex-governance-spike.md`
characterizes Codex's OWN native sandbox (Landlock fallback / bubblewrap
`workspace-write`/`read-only` modes) and its `app-server` approval-RPC — referenced
in §5 for the MCP-management comparison (`@openai/codex-sdk`'s `Thread`/`TurnOptions`
has no `setMcpServers` equivalent) and relevant background for §1b's Codex-state
carve-out discipline in `confine.rs`.

---

## Update — 2026-07-12, later same day (independent re-verification pass)

Re-verified against the live SDK docs (WebFetch, `code.claude.com/docs/en/sandboxing`,
this session) and the current repo state (HEAD `e00f70a7`, ~9.5h after this memo's
initial commit `2c20feec` at 12:22). All `sdk.d.ts` schema citations and the
worktree-`.git`/`settings.json`-protection/Bash-only-scope doc quotes in §1–§3
matched the fetched docs verbatim — **D3/D4 stand unchanged.** Two corrections:

1. **§4 is now DONE, not an open proposal.** `feat(review): verdict clamp +
   structured outputs + severity rubric (slice 1 of #197)` (`41eec03d`, 13:31 — ~1h
   after this memo) shipped exactly the recipe below for pr-review:
   `PR_REVIEW_OUTPUT_FORMAT` (`pr-review/findings.ts:137`), `outputFormat` added to
   `SessionConfigParts` (`scan-manager.ts:172-176`), wired in
   `PrReviewManager.sessionConfig()` (`manager.ts:121`), and `structuredOutput`
   threaded onto `SessionOutcome` (`scan-manager.ts:146`). Read §4 as a
   **retrospective proof-of-shape record**, not a TODO — the next candidate
   (Insight, per the roadmap) can reuse the same recipe.
2. **§5's Q3 answer was incomplete.** The SDK's live `Query` control object DOES
   support runtime MCP add/remove/reconfigure **without a session restart** — a
   real, load-bearing capability the original pass missed. §5 below is rewritten
   with the verified finding.
3. **The confined-terminal writer (`confine.rs`) was out of scope originally — added
   as new §1b.** The spike's brief asks about BOTH custom Seatbelt writers
   (`confine.rs` for the confined-terminal use case, `sandbox.ts` for agent-write
   confinement); this memo's §1/D3/D4 only ever covered `sandbox.ts` (matching the
   roadmap's own D3/D4 framing). `Options.sandbox` cannot apply to `confine.rs` at
   all — it wraps only the SDK's own `query()` Bash tool, and `confine.rs` spawns a
   plain PTY shell outside any SDK call. The one Anthropic-native primitive that
   COULD apply (`@anthropic-ai/sandbox-runtime`, a standalone process-wrapper CLI) is
   a beta research preview — verdict: KEEP `confine.rs`, watch `sandbox-runtime`.
   See §1b.

---

## §1 Executive recommendation — **HYBRID (adopt native sandbox for the OS layer; KEEP the PreToolUse gate)**

Adopt the SDK's native `Options.sandbox` to **replace the custom Seatbelt writer**
(`packages/engine/src/providers/claude/sandbox.ts`, 372 lines + `sandbox.test.ts`
399 lines + the premium-billed macOS CI lane at `.github/workflows/ci.yml:40-60`),
and **keep every PreToolUse policy gate** (`packages/engine/src/policy/**`) exactly
as-is. This is not "adopt vs keep" — the two layers cover **disjoint** tool surfaces
and must both exist. Five load-bearing reasons:

1. **The native sandbox and the custom Seatbelt writer do the *same job* (deny-write-
   except-cwd for shell subprocesses) — one is maintained by Anthropic, the other by
   us.** Nightcore's writer hand-rolls: TinyScheme profile generation
   (`sandbox.ts:104-127`), a wrapper-script exec shim (`:141-155`), an availability
   probe (`:180-197`), worktree `.git`-common-dir derivation (`:221-247`), and the
   `~/.claude` config-poisoning carve-out (`:286-303`). The native sandbox does **all
   of these for free**, including the worktree case ("the sandbox also allows writes
   to the main repository's shared `.git` directory … Writes to `hooks/` and `config`
   inside that directory remain denied" — docs, Filesystem isolation) and the config
   self-protection ("the sandbox automatically denies write access to Claude Code's
   `settings.json` files at every scope" — docs, Security limitations).

2. **It closes the Linux/WSL gap (security F2) for free.** Nightcore's writer is
   macOS-only — `probeSandbox()` returns `false` on any non-darwin host
   (`sandbox.ts:181`), so **Linux and Windows task runs have zero OS containment
   today**. The native sandbox runs on macOS (Seatbelt), Linux (bubblewrap), and WSL2
   (bubblewrap); the `SandboxSettings` schema even carries `bwrapPath`/`socatPath`
   (`sdk.d.ts:2690-2691`). Native Windows is still unsupported (must use WSL2) — that
   residual moves to the "Windows containment" v0.5 item, unchanged.

3. **But the native sandbox is Bash-only, so it cannot replace the PreToolUse gate.**
   Primary source, verbatim: *"The sandbox isolates Bash subprocesses. Other tools
   operate under different boundaries: Built-in file tools: Read, Edit, and Write use
   the permission system directly rather than running through the sandbox"* (docs,
   Scope). Nightcore's real worktree-escape incident (2026-07-01) was a `Write`/`Edit`
   to the parent repo — a **native tool call**, which the OS sandbox never sees. The
   PreToolUse gate is the *only* thing that confines `Write`/`Edit`/`MultiEdit`/
   `NotebookEdit`/`ApplyPatch` and `mcp__*` writes (`workspace-confinement.ts:154-295`),
   escalates exec-sink writes (`exec-sink.ts`), hard-denies `.git/config` poisoning
   (`confinement/git-config.ts`), and blocks credential-store reads
   (`confinement/sensitive-read.ts`). None of that is in scope for the command sandbox.
   Deleting it would re-open every hole it closes.

4. **`sandbox.credentials` adds a capability we have never had — "secrets never enter
   the agent" — but the marketed `mask` mode is a version-gated hazard, not free.**
   At the **pinned 0.3.190**, `SandboxCredentialsConfig` is `mode: 'deny'`-**only**
   for both files and env vars, and the SDK's own schema comment says mask "sandbox-
   runtime can't enforce yet; widen the mode (e.g. `mask`) only once a sandbox-runtime
   version that enforces it ships" (`sdk.d.ts:2585-2600`). `mask` + `injectHosts`
   **does** exist in the current CLI docs but requires Claude Code **v2.1.199+** *and*
   `network.tlsTerminate` *and* a newer SDK than we pin. So: adopt `deny` now (unset
   `GITHUB_TOKEN`/AWS/`ANTHROPIC_*` from sandboxed Bash, block `~/.aws`/`~/.ssh`
   reads), and treat `mask` as a **later, re-verified** follow-up — the roadmap §2.3
   "credential mask" claim is real but **not shippable at our pinned version**.

5. **The migration surface is tiny and the deletion is large.** The entire wiring is
   one `if (this.cfg.sandboxWrites === true)` block that swaps
   `pathToClaudeCodeExecutable` for a wrapper (`session-runner.ts:275-288`). Replacing
   it with `options.sandbox = {…}` deletes ~840 lines of security-critical custom code
   + a premium macOS CI lane, and hands the containment guarantee to a layer Anthropic
   fuzzes and ships weekly. That is exactly the roadmap's "adopt-don't-maintain" thesis.

**Net:** delete the `sandbox.ts` Seatbelt writer, wire `Options.sandbox`, keep the
PreToolUse gate as the permanent tool-input layer. The two are complementary (docs,
"How sandboxing relates to permissions": *"complementary layers"*). This verdict is
scoped to `sandbox.ts` only — see §1b immediately below for the confined-terminal
writer, which is a SEPARATE decision.

---

## §1b — The OTHER custom Seatbelt writer: `confine.rs` (confined-terminal) — KEEP, watch `@anthropic-ai/sandbox-runtime`

Nightcore actually has **two** independent custom Seatbelt writers, and this spike's
Q1 explicitly asks about both. §1/§3–§6/D3/D4 above (matching the roadmap's own D3/D4
framing, `2026-07-11-roadmap-v0.3-v0.5.md:380-381`) are scoped to `sandbox.ts` — the
**agent-write-confinement** case (wraps the Claude Agent SDK's own `query()` Bash
tool). `apps/desktop/src-tauri/src/terminal/confine.rs` (1099 lines, hardened as
recently as PR #292/#291, 2026-07-12) is a **second, separate** writer for the
**confined-terminal** case: a Rust-spawned interactive PTY shell the user drives
directly — `sandbox-exec -f <profile> <shell> -i` (`confine.rs:1-19`, `prepare`
`:393`). This is architecturally outside the Claude Agent SDK entirely — there is no
`query()` call in this path, so **`Options.sandbox` (the SDK schema analyzed above)
literally cannot apply here**: it is a field on the SDK's `query()` `Options`, and
confine.rs never calls `query()`.

**Does ANY Anthropic-native primitive cover the confined-terminal use case?** Yes,
one — but it is a *different* primitive than `Options.sandbox`, and it changes the
verdict. The docs (`code.claude.com/docs/en/sandbox-environments`, fetched this
session) describe **`@anthropic-ai/sandbox-runtime`** (published to npm, confirmed
`v0.0.65` as of 2026-07-10 via `npm view`; NOT currently a Nightcore dependency) as a
**standalone CLI** built on the *same* Seatbelt/bubblewrap primitives, that wraps an
**arbitrary process**, not just a `query()` loop: *"npx @anthropic-ai/sandbox-runtime
claude … The same command works for sandboxing standalone MCP servers or other
helper processes."* Its settings schema (`~/.srt-settings.json`) is structurally
identical to `Options.sandbox.filesystem`/`network` (`allowWrite`/`denyWrite`/
`denyRead`/`allowRead`, `allowedDomains`/`deniedDomains`) — and it adds Linux
bubblewrap **and alpha-stage Windows** (`srt-win.exe`) coverage confine.rs has
neither of today.

**Recommend KEEP `confine.rs` for now — do not adopt `sandbox-runtime` in this
cycle.** Three reasons:
1. **Maturity.** The package's own README states it verbatim: *"The Sandbox Runtime
   is a research preview... APIs and configuration formats may evolve."* Adopting a
   beta external npm dependency to replace a just-hardened, fail-closed, unit-tested
   Rust module for a security-load-bearing confinement feature is the wrong trade at
   this maturity.
2. **Loss-of-control risk is real, not theoretical, for this specific feature.**
   confine.rs's whole value is the hand-tuned STATE-vs-CONFIG carve-out discipline —
   `claude_state_write_roots` (`:130`) allows `~/.claude` STATE dirs while denying
   `settings.json`/`plugins`/`CLAUDE.md` CONFIG (`:98-105`), and
   `codex_state_write_roots` (`:214`) deliberately **excludes** the `.codex` root
   itself, carving in only specific STATE files/dirs while explicitly keeping
   `auth.json`/`config.toml`/plugins/computer-use denied (`:149-203`) — a distinction
   won by a documented SBPL-delimiter incident (memory: `project_codex_confine_sbpl.md`,
   PR #292/#291). `sandbox-runtime`'s allow/deny-list schema is generic (no
   Claude-vs-Codex-vs-generic-shell awareness) — re-deriving this exact discipline
   against an evolving external schema is a worse trade than the "SBPL fragility"
   argument used to justify replacing `sandbox.ts` in §1, because confine.rs's
   fragility has already been found and fixed, recently, in-house.
3. **Posture mismatch:** confine.rs is deliberately **fail-closed** (`:8-16` —
   refuses the spawn rather than launch unconfined) specifically because a user who
   ticks "Confined" is asking for a hard guarantee; the SDK-side `sandbox.ts` is
   fail-open because it's an experimental default-off agent feature that must never
   strand a task (§2.1 above). `sandbox-runtime`'s stability posture doesn't yet
   inspire swapping in a load-bearing fail-closed path.

**Watch item, not a T16 blocker:** `sandbox-runtime` reaching 1.0 would be worth a
fresh look — it would let ONE Anthropic-maintained writer cover both the
confined-terminal AND (via wrapping the whole `claude` subprocess rather than only
its internal Bash tool) a strictly *stronger* agent-write posture than
`Options.sandbox` gives today (file tools/MCP/hooks too, not just Bash — see the
comparison table in `sandbox-environments`), plus genuine Windows coverage neither
current writer has. File this as a v0.5+ watch item, not part of T16's scope.

---

## §2 Current containment map (what / where / OS / residual gaps)

Nightcore has **two** independent containment layers today. Only the first is a
candidate for replacement.

### 2.1 OS layer — opt-in macOS Seatbelt WRITE sandbox (the replacement candidate)

| Aspect | Detail | Evidence |
|---|---|---|
| What | Wraps the resolved `claude` binary in `/usr/bin/sandbox-exec` with a `(allow default)` + `(deny file-write*)` + allow-roots profile — **write containment only**, reads + network stay open | `sandbox.ts:1-59`, `buildSeatbeltProfile` `:104-127` |
| Writable roots | session cwd; worktree `.git` common dir; `/dev`; temp trees; `~/.claude` state; `~/Library/Caches/claude-cli-nodejs` | `deriveWritableRoots` `:256-281` |
| Config carve-out | denies `~/.claude/settings.json`, `settings.local.json`, and the `~/.claude.json*` family even inside the writable root (hook-injection RCE) | `:283-303`, `:345-353` |
| Wiring | Rust global `sandbox_sessions` → `guardrails.sandbox_writes` → engine `sandboxWrites` → swap `pathToClaudeCodeExecutable` to the wrapper | `store/settings/model.rs:122`, `sidecar/commands.rs:107-110`, `session-runner.ts:275-288` |
| OS coverage | **macOS only** — `probeSandbox()` returns false on non-darwin | `sandbox.ts:181` |
| Default | **opt-in / default-off** (`sandbox_sessions: false`) | `store/settings/model.rs:523` |
| Failure posture | **fail-OPEN**: unavailable/failed → warn loudly, run unwrapped | `prepareWriteSandbox` `:328-337`, `:363-371` |
| CI proof | dedicated premium macOS lane runs the enforcement tests | `.github/workflows/ci.yml:40-60` |
| **Residual gaps (self-documented)** | (a) **no Linux/Windows coverage at all**; (b) the wrapper/profile live in a writable temp tree → a concurrent session could tamper a *not-yet-exec'd* sibling wrapper (`:54-58`); (c) reads + network fully open by design; (d) user hooks that write outside the roots break (observed: GitKraken SessionEnd) (`:49-52`) | module header `sandbox.ts:1-59` |

### 2.2 Tool-input layer — the bypass-proof PreToolUse gate (KEEP — not replaceable)

Runs inside the SDK `PreToolUse` hook, which fires **regardless of `permissionMode`**
including `bypassPermissions` (Nightcore's default), so it holds under the unattended
studio config. Orchestrated in `hook-bus.ts:139-198`, four tiers in order:

1. **Destructive-command deny** (`rm -rf`, force-push, network-exfil) — `tool-deny-policy.ts`.
2. **Workspace confinement** — file mutations outside run cwd are DENIED (native tools
   exact; Bash lexical/best-effort; `ApplyPatch` multi-target; MCP name-heuristic
   fallback); plus `.git/config` hard-deny (`confinement/git-config.ts`) and sensitive-
   read denylist (`confinement/sensitive-read.ts`). Facade + full gap list:
   `workspace-confinement.ts:1-89`, dispatch `:154-295`.
3. **Harness runtime policy** — per-project `protectedPaths` + Bash deny + tool
   deny/ask tiers (incl. `mcp__server__*` prefix tiers) from `.nightcore/harness.json`
   (`harness-policy.ts:163-234`).
4. **Exec-sink ASK** — writes to `.github/workflows/**`, `.claude/**`, `.git/hooks/**`,
   `.husky/**`, `package.json`, `.envrc`, `.mise.toml` are escalated to an interactive
   approval that holds under bypass (`exec-sink.ts:88-104`, `:207-236`).

**Residual gaps (self-documented, all "real containment is the OS sandbox"):** Bash
write vectors that can't be resolved lexically (`> $VAR/x`, `> $(…)`, `python -c
"open(...,'w')"`), symlink-in-two-steps (`ln -s /repo esc; Write esc/…`), and
unconventionally-named MCP writers (`workspace-confinement.ts:33-60`). **These are
precisely the gaps the native sandbox's OS-level enforcement closes** — the two layers
are designed to backstop each other.

---

## §3 Native sandbox capabilities (what the SDK offers NOW) + the gap-closure

`Options.sandbox?: SandboxSettings` is a **first-class typed option already present in
the pinned 0.3.190** (`sdk.d.ts:1770`, doc block `:1730-1768`). Full schema at
`sdk.d.ts:2639-2692`. Nightcore passes **nothing** sandbox-related to the SDK today —
it wraps the executable instead.

**Enable / degradation controls**
- `sandbox.enabled: boolean` — turn it on (`sdk.d.ts:2645`).
- `sandbox.failIfUnavailable: boolean` — **defaults `true` when `enabled:true`** via
  the Options path: if deps are missing (e.g. bubblewrap on Linux) or the platform is
  unsupported, `query()` **emits an error result and exits** rather than running
  unsandboxed (`sdk.d.ts:1743-1747`). Set `false` for graceful degradation. Note the
  polarity flip: Nightcore's custom path is fail-**open**; the native default is
  fail-**closed**. This is a D3-relevant knob.
- `sandbox.autoAllowBashIfSandboxed: boolean` — auto-approve sandboxed Bash without
  prompting (`sdk.d.ts:2647`); explicit deny/ask rules and `rm` of critical paths still
  prompt (docs, Sandbox modes).
- `sandbox.allowUnsandboxedCommands: boolean` — controls the model's
  `dangerouslyDisableSandbox` escape hatch (`sdk.d.ts:2648`; `sdk-tools.d.ts:477-479`).
  **Set `false` (strict) for Nightcore**: under our `bypassPermissions` default, an
  unsandboxed retry would auto-allow, silently defeating the boundary.

**Filesystem** (`SandboxFilesystemConfig`, `sdk.d.ts:2664-2670`): `allowWrite[]`,
`denyWrite[]`, `denyRead[]`, `allowRead[]`, `allowManagedReadPathsOnly`. Default =
write cwd + session `$TMPDIR`, read whole machine except denied (docs). This is a
**direct, declarative replacement** for `deriveWritableRoots` + `buildSeatbeltProfile`.

**Network** (`SandboxNetworkConfig`, `sdk.d.ts:2649-2663`): `allowedDomains[]`,
`deniedDomains[]`, `allowManagedDomainsOnly`, `allowUnixSockets[]`, `allowLocalBinding`,
`httpProxyPort`, `socksProxyPort`, `tlsTerminate{caCertPath,caKeyPath}`. A real egress
proxy — **beyond** Nightcore's current lexical Bash `network-exfiltration` deny rule.
Off by default (no domains pre-allowed); adopting network restriction is optional and
separable from write containment.

**Credentials** (`SandboxCredentialsConfig`, `sdk.d.ts:2671-2680`): `files:[{path,
mode:'deny'}]`, `envVars:[{name, mode:'deny'}]`.
- **Pinned 0.3.190 = `deny` only.** The schema literal is `z.ZodLiteral<"deny">` for
  both arrays, and the doc comment states mask is not yet enforceable (`:2585-2600`).
- **Current CLI docs** add `envVars … mode:'mask'` + `injectHosts[]` (files stay
  deny-only), requiring **Claude Code v2.1.199+**, `network.tlsTerminate`, and honoring
  it only from user/managed/CLI settings (never repo `.claude/settings.json`). Masking
  keeps `gh`/`npm` working while the agent only ever sees a per-session sentinel.
- **Verdict:** adopt `deny` now (a strict improvement — today Nightcore hands the
  agent's env to sandboxed shells uncontained); defer `mask` to a version-bump
  follow-up and **re-verify the SDK schema still gates it** before wiring.

**Other knobs:** `ignoreViolations`, `enableWeakerNestedSandbox` (Docker-in-Docker),
`enableWeakerNetworkIsolation` (MITM CA), `allowAppleEvents` (removes isolation —
leave OFF), `excludedCommands[]` (tools incompatible with the sandbox, e.g. `docker`,
`gh`/`gcloud` on macOS Go-TLS), `ripgrep` (`sdk.d.ts:2681-2691`).

**Embedding-app lockdown:** `Options.managedSettings` (`sdk.d.ts:1789-1812`) is the
"desktop app derives lockdown from its own config and enforces it on the spawned
subprocess, restrictive-only" path — Nightcore is the textbook case. The `sandbox`
block can be delivered here so a repo's `.claude/settings.json` cannot widen it.

**Gap-closure bought:** Linux/WSL containment (F2) for free; OS-enforced closure of the
PreToolUse layer's documented Bash-write residuals (redirects/symlinks/dynamic targets)
— *for Bash only*; env-credential stripping from sandboxed shells (new capability);
deletion of ~840 lines of custom security code + a premium CI lane; and worktree
`.git`/config-poison handling maintained upstream. **Not bought** (still the PreToolUse
gate's job): confinement of `Write`/`Edit`/`ApplyPatch`/`NotebookEdit`/`mcp__*`, exec-
sink ASK, `.git/config` deny, sensitive-read deny.

---

## §4 Structured-output migration recipe (proven on ONE scan family: **pr-review**) — SHIPPED, see Update above

**Why pr-review:** the roadmap ties structured outputs to the review-calibration build
(#197 / v0.4 §6), and pr-review has three parseable passes (lens findings, adversarial
validator, merge verdict) — the verdict being a single object is the cleanest possible
fit. Insight is the fallback candidate if pr-review is deferred.

**The template already exists** — `decompose` proved it (roadmap §9 item 8). It launches
with `Options.outputFormat = { type:'json_schema', schema:{…} }`
(`decompose.ts:41-65`), the SDK forces schema-conforming output and internally retries,
the result message carries `structured_output`, and the adapter prefers it over text
parse with a text fallback (`sdk-adapter.ts:465-506`; `subtasksFromStructuredOutput`
vs `parseSubtasks` in `decompose.ts:92-110`). The `error_max_structured_output_retries`
subtype maps to a distinct failure (`sdk-adapter.ts:506`), so a non-conforming run fails
**visibly** instead of emitting prose.

**Today, scans are prompt-and-parse (the fragile class):** `prReviewOutputContract()`
appends a *prose* "Output ONLY a JSON array" instruction (`pr-review/presets.ts:138-155`;
Insight's twin at `insight/presets.ts:108-128`), and the engine text-parses the result
string via `parsePrReviewFindings` (`pr-review/manager.ts:145-149`). `SessionConfigParts`
has **no `outputFormat` field** (`scans/shared/scan-manager.ts:156-162`), so scans can't
request structured output at all yet.

**Concrete steps (all mechanical, mirror decompose):**

1. **Define the schema.** Add `PR_REVIEW_OUTPUT_FORMAT` in `pr-review/findings.ts`
   (or `presets.ts`), object-wrapped `{ type:'object', properties:{ findings:{ type:
   'array', items:{…severity enum, file, line?, title, body, suggestedFix? } } },
   required:['findings'], additionalProperties:false }` — structured output requires
   `additionalProperties:false` at **every** object level (`decompose.ts:37-38`). Mirror
   the fields the model currently supplies in `prReviewOutputContract`; keep engine-
   assigned fields (`lens`, `id`, `fingerprint`) OUT of the schema (they're already
   engine-assigned, `presets.ts:136`).
2. **Plumb one field.** Add `outputFormat?: OutputFormat` to `SessionConfigParts`
   (`scan-manager.ts:156`) and thread it into the built `SessionRunnerConfig` with a
   `...(parts.outputFormat ? { outputFormat: parts.outputFormat } : {})` spread —
   right beside the existing `maxBudgetUsd` spread (`scan-manager.ts:459-462`). One line.
3. **Return it from the preset.** In `PrReviewManager.sessionConfig()` add
   `outputFormat: PR_REVIEW_OUTPUT_FORMAT` (`pr-review/manager.ts:119-127`).
4. **Surface `structured_output` on the scan completion path.** The scan
   `session-completed` event currently carries only `result: string`
   (`scan-manager.ts:465-468`). Generalize the runner completion event to also carry
   `structuredOutput` (the adapter already extracts it for decompose — lift that so
   every kind gets it), then have `parse()` prefer it: `structuredFindings(structured)
   ?? parsePrReviewFindings(result, lens)`. The text parser stays as the fallback for
   older/degraded runs — identical to decompose's dual path.
5. **Fail visible.** Map `error_max_structured_output_retries` (already a distinct
   `session-failed` reason) to a **degraded-lens** chip rather than an empty result —
   this is exactly the roadmap §5.2 "fail-visible reviews" requirement, and structured
   output makes the failure detectable.
6. **Repeat for the validator + verdict passes.** Verdict is a single object
   (`{ verdict:'can_merge'|'needs_revision'|…, rationale }`) — the highest-value, lowest-
   risk conversion; it removes the "reviewer isn't trusted at current noise" parse-drift
   the roadmap §6 review-calibration item calls out.

**Outcome for #197:** enforced per-lens output shape means the severity rubric,
verdict floor/ceiling, and dedupe logic operate on schema-valid data instead of
best-effort-parsed prose — the precondition for calibrating reviewer trust.

---

## §5 Runtime MCP management — exists (static, session-start-only), AND the SDK has a live-reconfigure API Nightcore doesn't call yet

**Exists (roadmap §9 item 1 confirmed) — static, session-start-only:**
- **CRUD UI:** `apps/web/src/components/settings/McpServersCard/**` (card, editor,
  hooks, stories) + `SettingsView.hooks.ts`.
- **Rust store + wire:** `store/settings/{model,patch,store}.rs`,
  `provider/{types,imp}.rs`, `sidecar/provider_config.rs`, generated contracts.
- **Per-session injection into the SDK:** `toSdkMcpServers()` folds enabled entries
  into `Options.mcpServers` **once, at `query()` construction**, additively over the
  user's native config (`session-options.ts:51-79`, `:353` / `:393-395`), shared by
  run + inspector probe. Editing a server in `McpServersCard` while a session is
  in flight has no effect on that session — it only applies to the *next* one.
- **Coarse governance already shipped:** harness-policy supports `mcp__server__*`
  prefix **deny/ask tiers** (`harness-policy.ts:163-234`, tests #223), and the bypass-
  mode MCP-containment fallback classifies + confines/denies write/network MCP tools,
  fail-closed on unknown (`confinement/mcp.ts:276-332`).

**The gap, corrected: the SDK's `Query` control object already exposes live
reconfiguration — Nightcore just isn't calling it.** `node_modules/@anthropic-ai/
claude-agent-sdk/sdk.d.ts` (pinned 0.3.190), on the `Query` interface returned by
`query()`:
- `setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>`
  (`:2420`) — *"Dynamically set the MCP servers for this session... Servers that are
  removed will be disconnected, and new servers will be connected... Note: This only
  affects servers added dynamically via this method or the SDK. Servers configured
  via settings files are not affected."* Returns `{ added, removed, errors }`
  (`:1060-1075`).
- `reconnectMcpServer(serverName): Promise<void>` (`:2390`) and
  `toggleMcpServer(serverName, enabled): Promise<void>` (`:2398`) for a single-server
  nudge without touching the rest.
- `setMcpPermissionModeOverride(serverName, 'default'|'auto'|null)` (`:2217`) — a
  **tighten-only** per-server permission pin the SDK enforces (docstring: "can never
  widen privilege").
- `mcpServerStatus(): Promise<McpServerStatus[]>` — connected/failed/needs-auth/pending
  state; Nightcore already probes this one (see below).

**All of the above are gated "only supported when streaming input/output is used"**
(`sdk.d.ts:2182-2186`, the `Query` interface's own doc block). **Nightcore already
qualifies.** `SessionRunner` launches every real run with
`query({ prompt: this.inputStream(), options })` (`session-runner.ts:297`), and its
own class doc says so explicitly: *"Uses streaming input mode (prompt is an
`AsyncIterable<SDKUserMessage>`) so the SDK's control requests are available —
`interrupt()` / `setModel()` etc. are only supported in streaming mode"*
(`session-runner.ts:124-130`). `SessionRunner` **already proxies three sibling
control methods through this exact pattern** — `interrupt()` (`:424`, `:436`),
`setModel()` (`:446`), `setPermissionMode()` (`:454`) — and already probes
`mcpServerStatus()` read-only (`:541-542`, consumed by `provider-config.ts`). Adding
`setMcpServers` / `reconnectMcpServer` / `toggleMcpServer` is the identical one-line
proxy shape, not new architecture.

**What this buys, concretely:** a user could add/remove/disable an MCP server from
`McpServersCard` **while a long-running task is mid-flight** and have it take effect
without killing and restarting the session (today: edit → save → the change is inert
until the *next* `query()`). It also unlocks a "reconnect" action for a server
`mcpServerStatus()` reports as `needs-auth`/`failed`, without a full session restart,
and — via `setMcpPermissionModeOverride` — a **live, tighten-only** per-server
lockdown a user or a harness-triggered escalation could apply mid-run without waiting
for the task to finish. `@openai/codex-sdk@0.142.5`'s `Thread`/`TurnOptions` surface
has no equivalent (only static MCP-tool-call *reporting* via `McpToolCallItem`,
`dist/index.d.ts:37-62`) — this capability is Claude-SDK-only.

**Residual gap, unaffected by the above:** per-server default governance **tier
selector in the UI** (today requires hand-authoring a `.nightcore/harness.json`
`mcp__<server>__*` rule; roadmap §9-1) and **interactive MCP auth** (OAuth/remote-
transport handshakes) are not surfaced by `setMcpServers`/`reconnectMcpServer`
either — those remain genuinely open.

**Is it worth it? Yes, as a small follow-up — not a T16 blocker.** Recommend:
thread `setMcpServers` / `reconnectMcpServer` / `toggleMcpServer` onto
`SessionRunner` mirroring the existing `setModel`/`setPermissionMode` proxy; wire a
"reconnect" affordance onto `McpServersCard` rows keyed off `mcpServerStatus()`; and
gate the mid-run "apply now" action behind the same governance tiers
`confinement/mcp.ts` already enforces (a live-added server must still classify
through the fail-closed-on-unknown path — `setMcpServers` bypasses none of that, it
only changes *when* a server connects, not *what* it's allowed to do once connected).
This is orthogonal to the sandbox adopt/keep decision and should not gate T16; the
per-server default-tier UI selector remains the higher-value near-term item if only
one MCP follow-up gets picked up next.

---

## §6 Migration plan (execution ticket T16 / #157) — ordered, with risk notes

**Invariant (do not revisit): KEEP the PreToolUse gate.** The native sandbox is
Bash-only; the gate is the sole layer over `Write`/`Edit`/`ApplyPatch`/`NotebookEdit`/
`mcp__*` and the only place exec-sink/`.git/config`/sensitive-read live. Adopting the
sandbox changes the *OS layer* only.

1. **Preflight capability probe.** Add a provider capability that reports whether the
   installed `claude` CLI + platform support the native sandbox (probe `/sandbox` deps:
   Seatbelt on macOS; bubblewrap+socat on Linux/WSL2). Cache like `sandboxAvailable()`.
   *Risk:* the user's installed `claude` is a REQUIRED prereq (decided 2026-06-23) and
   its version varies; `mask` needs v2.1.199+ — gate features on the probed version, not
   on the SDK version alone.
2. **Wire `Options.sandbox` in the session path only.** In `session-options.ts run()`,
   emit `sandbox: { enabled: true, failIfUnavailable: <D3>, allowUnsandboxedCommands:
   false, filesystem: { allowWrite: [<cwd + worktree .git common dir + temp>] },
   credentials: { envVars: [deny GITHUB_TOKEN/AWS_*/ANTHROPIC_*…], files: [deny ~/.aws,
   ~/.ssh, ~/.gnupg…] } }` when the guardrail is on. Keep `pathToClaudeCodeExecutable =
   claudePath` (still needed for the compiled `$bunfs` resolution) but **stop swapping
   it for a wrapper**. Scans need nothing (read-only, no execution surface).
3. **Delete the custom writer.** Remove `sandbox.ts`, `sandbox.test.ts`, the
   `session-runner.ts:275-288` wrapper block, and simplify the macOS CI lane
   (`ci.yml:40-60`) to a native-sandbox smoke test (or drop it — the guarantee is now
   upstream's).
4. **Reconcile the Rust seam.** `sandbox_sessions` → engine flag stays the wire; the
   engine now emits `Options.sandbox` instead of a wrapper. Serde-additive; no contract
   break. *Risk:* keep the loud-unavailability warning (see D3) — with `failIfUnavailable`
   the run now *errors* rather than silently degrading, so the UI must explain why.
5. **Adopt `credentials.deny` immediately; park `mask`.** Ship env/file deny now. File a
   follow-up for `mask`+`injectHosts` gated on: SDK schema widening past `deny`
   (`sdk.d.ts:2585-2600` re-check), CLI ≥ v2.1.199, and `network.tlsTerminate` wiring.
6. **Optional, separable: network egress.** `allowedDomains`/proxy is a *later* toggle;
   don't couple it to write containment in the first cut (default = prompt-on-new-domain
   would fight the unattended flow). Revisit with the budget/usage work.
7. **Dogfood assertion.** Extend the workspace-confinement dogfood check to assert both
   layers fire under `bypassPermissions`: a Bash redirect to `$HOME` is OS-denied AND a
   `Write` to the parent repo is gate-denied.

**Cross-cutting risks:** (a) `failIfUnavailable` polarity flip (fail-open→fail-closed)
is a behavior change users will notice on unsupported hosts — needs the D3 opt-out +
loud surface. (b) macOS Go-TLS tools (`gh`, `gcloud`) and `docker` need `excludedCommands`
or they break under Seatbelt (docs, Troubleshooting) — pre-seed the exclusion list. (c)
`--dangerously-skip-permissions`/`allowDangerouslySkipPermissions` as root is blocked
unless inside a recognized sandbox — should *improve* under native sandbox, but verify on
Linux CI. (d) SDK release cadence becomes a dependency — mitigated because the PreToolUse
gate remains the independent backstop if a sandbox regression ships.

---

## §7 Decisions for the user

### D4 — Native-sandbox adoption (adopt vs keep)

> **Question:** Should Nightcore delete its custom macOS Seatbelt writer and adopt the
> SDK's native `Options.sandbox` (gaining Linux/WSL containment + env-credential
> stripping, and offloading maintenance to Anthropic), while keeping the PreToolUse
> policy gate unchanged — accepting that OS write-containment now depends on Anthropic's
> release cadence and that `mask` credential mode isn't available until a CLI/SDK bump?

**Recommended answer: YES — adopt (HYBRID).** Replace the OS layer, keep the gate. The
native sandbox does strictly more than the custom writer (Linux + WSL + credentials)
while deleting ~840 lines of security-critical code and a premium CI lane, and the
PreToolUse gate already covers everything the Bash-only sandbox cannot, so the "keep as
fallback" option buys little except maintenance. **The tradeoff to weigh:** you trade a
self-owned, macOS-only, fail-open writer for an Anthropic-owned, cross-platform,
fail-closed one — accepting SDK-cadence dependency (mitigated by the independent gate)
and deferring `mask` to a version-gated follow-up.

### D3 — Sandbox-by-default flip staging

> **Question:** Should the write-sandbox move from opt-in (`sandbox_sessions: false`)
> toward default-on, and if so how staged — start macOS + worktree-mode only (disjoint
> cwd, lowest false-positive surface) with a per-run opt-out and `failIfUnavailable:
> false` + a loud "containment unavailable" surface, then widen to Linux and main-mode
> once telemetry is clean; or hold at opt-in until cross-platform is proven?

**Recommended answer: YES, staged — default-on for macOS + worktree-mode first, opt-out
retained, `failIfUnavailable: false` with a loud unavailability pill, telemetry before
widening.** Worktree mode has a disjoint cwd (lowest false-positive risk), and the native
sandbox's built-in worktree `.git` handling removes the fragile custom derivation. Keep
`failIfUnavailable: false` during staging so an unsupported host degrades (with a visible
banner) rather than stranding every task; only flip to `failIfUnavailable: true` for a
future "hardened/managed" posture. **The tradeoff to weigh:** default-on matches the
governed-autonomy brand and closes the F2 Linux gap for real users, but known hook
breakage (e.g. GitKraken SessionEnd writing outside cwd) and `excludedCommands`-class
tool friction (`gh`/`docker`) will generate first-run surprises — hence opt-out +
loud surface are non-negotiable parts of the flip.
