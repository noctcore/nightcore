# Research: Codex `app-server` approval spike, re-run against codex-cli 0.145.0 (#304)

**Date:** 2026-07-31
**Status:** complete — spike only, no provider behaviour changed
**Scope:** the verification spike the maintainer greenlit on #304. Re-runs the
2026-07-12 spike (`docs/research/2026-07-12-codex-governance-spike.md`, codex-cli
0.144.1) against the currently installed **codex-cli 0.145.0**, and answers the two
questions that spike left un-tested: MCP tool-call approvals, and wire-schema drift.

**Authorization boundary:** this document is evidence and a recommendation. Nothing
in `packages/engine/src/providers/codex/**` was touched. `CodexSession` still drives
`@openai/codex-sdk`'s `Thread.runStreamed()`; the #296 fail-closed refuse is
unchanged. The upstream feature request in §8 was **drafted, not filed**.

---

## VERDICT

**The seam is real and works. Two of the three "structural limits" in #304 are wrong
on 0.145.0 — and the third is narrower than stated.**

| #304 claim | Verdict on 0.145.0 | Evidence |
|---|---|---|
| Approval events fire, synchronously, pre-execution | **CONFIRMED** | §3 |
| Replying deny genuinely blocks | **CONFIRMED at the filesystem level**, with an accept control proving causality | §4 |
| A "trusted command" classifier silently bypasses approval | **CONFIRMED but scoped**: bypass is limited to *non-mutating* commands. Every one of 5 mutating commands requested approval and was blocked. | §5 |
| "There is **NO** approval event for MCP tool calls" | **REFUTED.** MCP tool calls are gated, via `mcpServer/elicitation/request` carrying `_meta.codex_approval_kind: "mcp_tool_call"`. Declining prevented the tool from executing — verified from *inside* the MCP server process. | §6 |
| Legacy method names `execCommandApproval` / `applyPatchApproval`, decision `allow`/`deny` | **STALE** (already stale at 0.144.1). Live names are `item/*/requestApproval`; vocab is `accept`/`decline`. | §7 |
| Wire schema is experimental and evolving | **CONFIRMED, with a fresh breaking change**: `approval_policy: "on-failure"` is now **rejected** by `thread/start` — while `@openai/codex-sdk@0.145.0` still declares it in `ApprovalMode`. | §7 |

**Recommendation: still do NOT re-architect the turn-driver.** See §9. The seam works,
but the cost/benefit did not move enough to overturn the 2026-07-12 maintainer DEFER,
and this spike found a *new* reason for caution (§7.3: a same-version divergence
between the npm SDK's declared enum and what the app-server actually accepts, plus
§2.4: `thread/start` silently writes to the user's global `~/.codex/config.toml`).

---

## 1. Environment

| | |
|---|---|
| CLI | `codex-cli 0.145.0` (`codex --version`) |
| npm SDK pinned in `packages/engine/package.json` | `@openai/codex-sdk@0.145.0` |
| Platform | macOS (Darwin 25.5.0), arm64, Seatbelt sandbox backend |
| Auth | ChatGPT login (`plan_type: "plus"`), `~/.codex/auth.json` present |
| Model | `gpt-5.5`, reasoning effort `medium` (account default) |
| Scratch repos | throwaway git repos under a scratchpad dir — **never** the nightcore checkout |

Two environment caveats that a re-runner must control for:

- The host has a user-scope `~/.codex/hooks.json` (installed by Orca) whose handlers
  are no-ops. Its `hook/started` / `hook/completed` notifications appear throughout
  every transcript below. They do not affect any approval outcome, but they are why
  hook frames show up in the raw evidence.
- The host has four pre-existing MCP servers configured globally; `ref` fails
  startup with HTTP 401 in every run. Unrelated to this spike.

## 2. Procedure (re-runnable)

### 2.1 Get the authoritative wire schema for the installed binary

```
codex app-server generate-ts --out ./ts-bindings
codex app-server generate-ts --experimental --out ./ts-bindings-exp
```

`ServerRequest.ts` is the single most useful file: it is the **complete union of
every request the server can send the client**, i.e. the exhaustive list of
interception points. Diff it against a previous version to detect drift in one step.

### 2.2 The driver

A ~110-line throwaway Node script spawning `codex app-server --stdio`, recording
**every** frame in both directions to JSONL, and answering approval requests from a
fixed decision:

```js
// initialize -> initialized -> thread/start -> turn/start, then answer server requests
const init = await call('initialize', {
  clientInfo: { name: 'nightcore-spike', title: 'nightcore-spike', version: '0.0.0' },
  capabilities: null,
});
send({ jsonrpc: '2.0', method: 'initialized', params: {} });

const started = await call('thread/start', {
  cwd: ws,
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',   // MUST be pinned — see §10
  sandbox: 'workspace-write',
});
const threadId = started.result.thread.id;

await call('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });

// server -> client requests (they carry BOTH `method` and `id`):
function onServerRequest(msg) {
  if (msg.method.endsWith('/requestApproval'))          reply({ decision });             // accept | decline
  else if (msg.method === 'mcpServer/elicitation/request')
                                                        reply({ action: decision,        // accept | decline
                                                                content: decision === 'accept' ? {} : null });
  else                                                  reply({});
}
```

Dispatch rule that matters: a **server request** has both `method` and `id`; a
**notification** has `method` and no `id`; a **response** has `id` and no `method`.

### 2.3 The runs

| Run | Policy | Decision | Prompt |
|---|---|---|---|
| deny | `untrusted` | `decline` | `ls -la`, then `touch mutate.txt`, then create `result.txt` |
| accept (control) | `untrusted` | `accept` | identical |
| classifier battery | `untrusted` | `accept` | `ls -la`, `cat README.md`, `echo hello-probe`, `git status`, `rm probe-victim.txt`, `curl … https://example.com` |
| governance battery | `untrusted` | `accept` | `cat .env`, `echo pwned > package-lock.json`, `printf … >> AGENTS.md`, `git commit --no-verify` |
| mutation battery | `untrusted` | `decline` | `mkdir`, `chmod 777`, `sed -i`, `ln -s`, `mv` |
| MCP deny / MCP accept | `untrusted` | `decline` / `accept` | call a purpose-built MCP tool that writes a marker file |

Every run's verdict is checked **against the filesystem** afterwards, never against
the agent's own narration.

### 2.4 Side effect a re-runner must know about (NEW — not in the 0.144.1 spike)

`thread/start` **silently writes a trust entry for `cwd` into the user's global
`~/.codex/config.toml`.** Verified with a zero-token probe that does `initialize` +
`thread/start` and nothing else:

```
trust entry present BEFORE thread/start: false
thread/start ok, threadId = 019fba9a-da64-7e71-ad62-7765d89c2aa0
trust entry present AFTER  thread/start: true
entry: [projects."/…/spike/ws-trustprobe"] | trust_level = "trusted"
```

Two consequences:

1. **The 0.144.1 spike's "untrusted-by-omission scratch dir" caveat is void.** Its
   open question — "does project trust level change which commands the classifier
   auto-runs?" — is not answerable through `thread/start`, because `thread/start`
   makes the project trusted before the first command is ever classified. All results
   below are therefore *already* the trusted-project case, which is the realistic
   Nightcore case (real repos are trusted).
2. An app-server-driven Nightcore would **mutate the user's global Codex config on
   every task start**. That is a real (if minor) product-surface objection to Option B
   that was previously unknown.

## 3. Q1 — Do the approval events actually fire?

**YES.** Raw frames, verbatim from the deny run.

Shell command (`touch mutate.txt`):

```json
{
  "method": "item/commandExecution/requestApproval",
  "id": 0,
  "params": {
    "threadId": "019fba98-6d20-72f0-95d9-44d84926cf3e",
    "turnId": "019fba98-6fde-7750-b42e-4c5c3dacd539",
    "itemId": "call_bNm5LJN8W6IKikho13lBOjfo",
    "startedAtMs": 1785541996535,
    "environmentId": "local",
    "command": "/bin/zsh -lc 'touch mutate.txt'",
    "cwd": "/…/spike/ws-deny",
    "commandActions": [{ "type": "unknown", "command": "touch mutate.txt" }],
    "proposedExecpolicyAmendment": ["touch", "mutate.txt"],
    "availableDecisions": [
      "accept",
      { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": ["touch", "mutate.txt"] } },
      "cancel"
    ]
  }
}
```

File change (`result.txt`):

```json
{
  "method": "item/fileChange/requestApproval",
  "id": 1,
  "params": {
    "threadId": "019fba98-6d20-72f0-95d9-44d84926cf3e",
    "turnId": "019fba98-6fde-7750-b42e-4c5c3dacd539",
    "itemId": "call_5EuGYYtJjhztkuyHxxZN6SxB",
    "startedAtMs": 1785542001044,
    "reason": null,
    "grantRoot": null
  }
}
```

Both are genuine JSON-RPC **requests** (they carry an `id`); the turn parks on
`thread/status/changed → activeFlags: ["waitingOnApproval"]` until answered, and the
server emits `serverRequest/resolved` on receipt. This is synchronous, pre-execution,
and client-controlled — exactly what a `PreToolUse` analog needs.

**Adapter trap:** `item/fileChange/requestApproval` carries **no path list**. The
paths live in the preceding `item/started` notification for the same `itemId`
(`{"type":"fileChange","id":"call_5Eu…","changes":[{"path":"…"}]}`). An adapter must
buffer `item/started` and join on `itemId` — the approval frame alone cannot be
evaluated against `protectedPaths`.

## 4. Q2 — Does replying `deny` genuinely block?

**YES — proven at the filesystem level, with a control run proving causality.**

Deny run (`{"decision":"decline"}` to both requests), scratch repo afterwards:

```
$ ls -la ws-deny
drwxr-xr-x  .git
-rw-r--r--  README.md          # ← only the pre-existing baseline file
```

Neither `mutate.txt` nor `result.txt` exists. Corroborating signals:

- item frame: `"status": "declined"`, `"processId": null`, `"exitCode": null` — the
  process was never created.
- server stderr: `exec_command failed for '/bin/zsh -lc 'touch mutate.txt'': CreateProcess { message: "Rejected(\"rejected by user\")" }`
- agent narration (**not** treated as evidence, recorded only for completeness):
  *"Step 2 failed: `touch mutate.txt` was rejected by the user approval flow."*

Accept control — byte-identical turn, only the decision string changed to `accept`:

```
$ ls -la ws-accept
drwxr-xr-x  .git
-rw-r--r--  mutate.txt         # 0 bytes
-rw-r--r--  README.md
-rw-r--r--  result.txt         # 17 bytes
$ cat ws-accept/result.txt
hello-from-spike
```

Same prompt, same policy, opposite decision, opposite filesystem outcome. This is a
real bidirectional gate, not a coincidental no-op.

## 5. Q3 — Which commands bypass approval?

Battery of six representative commands, `approvalPolicy: "untrusted"` (the strictest
policy), each issued as its own shell tool call, correlated by `itemId` between
`item/started` and `item/commandExecution/requestApproval`:

| # | command | approval requested? | outcome |
|---|---|---|---|
| 1 | `ls -la` | **NO** | ran, exit 0 |
| 2 | `cat README.md` | **NO** | ran, exit 0, content returned |
| 3 | `echo hello-probe` | **NO** | ran, exit 0 |
| 4 | `git status` | **NO** | ran, exit 0 |
| 5 | `rm probe-victim.txt` | **YES** | gated |
| 6 | `curl -sS … https://example.com` | **YES** | gated |

**4 of 6 bypassed.** Second battery, on the two axes Nightcore's Harness policy
actually enforces:

| command | Harness axis | approval requested? |
|---|---|---|
| `cat .env` | protected-path **read** | **NO** — secret returned in cleartext |
| `git commit --no-verify --allow-empty -m probe` | `denyBashPatterns` | **YES** |

The `cat .env` bypass is the sharpest finding in the whole spike, because Codex's own
classifier **already knows exactly which file is being read** and auto-runs it anyway:

```json
{"type":"commandExecution","id":"call_3RZ0nyNO3ro9otga4b4GEYt3",
 "command":"/bin/zsh -lc 'cat .env'","status":"completed",
 "commandActions":[{"type":"read","command":"cat .env","name":".env",
                    "path":"/…/spike/ws-gov/.env"}],
 "aggregatedOutput":"SECRET_TOKEN=sk-spike-do-not-read\n","exitCode":0}
```

`commandActions[0].type == "read"` is the classifier's verdict, and `"read"` ⇒ no
approval request. A `protectedPaths` rule denying reads of `.env` is therefore
**structurally unenforceable** through this seam, no matter how the adapter is built.

### 5.1 …but the bypass does not extend to mutations

The decisive counter-test: five *mutating* commands chosen to look innocuous, all
answered `decline`:

| command | approval requested? | status |
|---|---|---|
| `mkdir probe-dir` | **YES** | declined |
| `chmod 777 package-lock.json` | **YES** | declined |
| `sed -i "" s/lockfileVersion/LOCKED/ package-lock.json` | **YES** | declined |
| `ln -s /etc/hosts linkprobe` | **YES** | declined |
| `mv AGENTS.md AGENTS-moved.md` | **YES** | declined |

Filesystem afterwards: no `probe-dir`, no `linkprobe`, `AGENTS.md` still in place,
`package-lock.json` byte-unchanged and permissions unchanged. **5/5 gated, 5/5
blocked.**

**Therefore the trusted-command bypass is a READ and AUDIT-COMPLETENESS gap, not a
WRITE-ENFORCEMENT gap** — a materially narrower claim than #304 currently makes.

### 5.2 The audit half of the gap is also smaller than previously stated

The 0.144.1 spike concluded bypassed commands mean "no gate, **no ledger record**".
The first half holds; the second does not. Every bypassed command still produced full
`item/started` + `item/completed` notifications carrying `command`, `cwd`,
`commandActions`, `exitCode` and `aggregatedOutput`. An app-server-driven adapter
could therefore feed `SessionLedger` a complete, if **post-hoc**, record of bypassed
commands. What is lost is the *pre-execution veto*, not the audit trail.

### 5.3 One non-guarantee to record honestly

Two prompted steps (`echo pwned > package-lock.json`, `printf … >> AGENTS.md`) never
reached the shell at all. The agent reported them as *"not run: blocked by
shell-editing rule"* — a **model-level instruction**, not an enforcement gate. It
must not be counted as a governance guarantee: it is a behaviour, and behaviours
can be prompted around.

## 6. Q4 — Is there an approval event for MCP tool calls?

**YES. #304's claim that there is none is REFUTED on 0.145.0.**

Method: a purpose-built throwaway MCP stdio server exposing one tool,
`spike_write_marker`, which performs a **real filesystem write** and logs every
JSON-RPC message it receives. Registered through the same `-c` config passthrough
Nightcore already uses for `mcp_servers`. This makes the verification third-party:
the MCP server is a separate process, so "did the tool actually run" is answered by
the server's own log, not by Codex and not by the agent.

The gate arrives on the MCP-elicitation channel, discriminated by a Codex-specific
`_meta` marker:

```json
{
  "method": "mcpServer/elicitation/request",
  "id": 0,
  "params": {
    "threadId": "019fba9e-39bf-7e83-bdba-ceaae6c16aca",
    "turnId": "019fba9e-3a9f-7a31-bc70-3fa278a805bf",
    "serverName": "spike",
    "mode": "form",
    "_meta": {
      "codex_approval_kind": "mcp_tool_call",
      "persist": ["session", "always"],
      "tool_description": "Writes a marker file to an absolute path on the local filesystem. …",
      "tool_params": { "path": "/…/ws-mcp/mcp-marker.txt", "text": "mcp-tool-ran" },
      "tool_params_display": [ … ]
    },
    "message": "Allow the spike MCP server to run tool \"spike_write_marker\"?",
    "requestedSchema": { "type": "object", "properties": {} }
  }
}
```

Decline (`{"action":"decline"}`):

```json
{"type":"mcpToolCall","id":"call_ZppW0MAWCtT9evw8YYBpQ1Dt","server":"spike",
 "tool":"spike_write_marker","status":"failed",
 "arguments":{"path":"/…/ws-mcp/mcp-marker.txt","text":"mcp-tool-ran"},
 "result":null,"error":{"message":"user rejected MCP tool call"},"durationMs":0}
```

- MCP server log: `initialize`, `notifications/initialized`, `tools/list` — and **no
  `tools/call` ever arrived**.
- Filesystem: `mcp-marker.txt` does not exist.

Accept control (`{"action":"accept"}`), same turn:

- MCP server log: `{"method":"tools/call","params":{…,"name":"spike_write_marker","arguments":{"path":"/…/mcp-marker.txt","text":"mcp-tool-ran"}}}` followed by the server's own `tool-executed` entry.
- Filesystem: `mcp-marker.txt` exists, content `mcp-tool-ran`.

**This is the one axis where the approval gate is the *only* containment.** The MCP
server runs as an ordinary child process outside the Seatbelt sandbox — it wrote the
file with no sandbox involvement. So `providesOwnWriteContainment: true` in
`packages/engine/src/providers/codex/capabilities.ts` does **not** cover MCP tool
calls, and this newly-discovered gate is precisely what would close that hole.

### 6.1 Adapter traps on this channel

1. **The tool name is not a structured field.** `_meta` carries `tool_description`
   and `tool_params`, but the tool's *name* appears only inside the English
   `message` string. Mapping onto Harness's `mcp__server__tool` deny-globs requires
   either parsing that sentence or joining to the preceding `item/started`
   (`{"type":"mcpToolCall","server":"spike","tool":"spike_write_marker"}`).
2. **There is no `itemId` in the approval params.** The join must be on
   `(threadId, turnId, serverName)` plus the most recent in-progress `mcpToolCall`
   item — ordering-dependent and fragile under any future concurrency.
3. **It shares a method with genuine MCP elicitations.** A client must branch on
   `_meta.codex_approval_kind === "mcp_tool_call"`; answering a real elicitation with
   an approval decision (or vice versa) is a silent correctness bug.

## 7. Q5 — Wire-schema stability

### 7.1 Stable since 0.144.1

Approval method names and decision vocabularies did **not** move between 0.144.1 and
0.145.0: `item/commandExecution/requestApproval` + `item/fileChange/requestApproval`,
`accept | acceptForSession | decline | cancel`. The legacy
`execCommandApproval` / `applyPatchApproval` pair still exists in the generated
bindings but still does not fire for a `capabilities: null` client.

### 7.2 Complete interception surface on 0.145.0

`ServerRequest.ts` (generated, authoritative):

```ts
export type ServerRequest =
  | { method: "item/commandExecution/requestApproval", id, params: CommandExecutionRequestApprovalParams }
  | { method: "item/fileChange/requestApproval",       id, params: FileChangeRequestApprovalParams }
  | { method: "item/tool/requestUserInput",            id, params: ToolRequestUserInputParams }
  | { method: "mcpServer/elicitation/request",         id, params: McpServerElicitationRequestParams }
  | { method: "item/permissions/requestApproval",      id, params: PermissionsRequestApprovalParams }
  | { method: "item/tool/call",                        id, params: DynamicToolCallParams }
  | { method: "account/chatgptAuthTokens/refresh",     id, params: ChatgptAuthTokensRefreshParams }
  | { method: "attestation/generate",                  id, params: AttestationGenerateParams }
  | { method: "applyPatchApproval",                    id, params: ApplyPatchApprovalParams }   // legacy
  | { method: "execCommandApproval",                   id, params: ExecCommandApprovalParams }; // legacy
```

`item/permissions/requestApproval` is **new** relative to what the 0.144.1 spike
recorded — a fourth gate (sandbox-escape / permission-profile escalation).

### 7.3 A fresh breaking change — and a same-version SDK divergence

Zero-token probe: which `approvalPolicy` values does `thread/start` accept?

```
ACCEPTED  approvalPolicy=never
ACCEPTED  approvalPolicy=untrusted
ACCEPTED  approvalPolicy=on-request
REJECTED  approvalPolicy=on-failure
          -> {"code":-32600,"message":"Invalid request: unknown variant `on-failure`,
                expected one of `untrusted`, `on-request`, `granular`, `never`"}
REJECTED  approvalPolicy={"granular":{…}}
          -> {"code":-32600,"message":"askForApproval.granular requires experimentalApi capability"}
```

Two things fall out:

- **`on-failure` was removed** from the app-server's `AskForApproval` — yet
  `@openai/codex-sdk@0.145.0`'s `dist/index.d.ts` still declares
  `type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted"`. The npm
  SDK's type surface and the app-server's accepted values **have diverged inside the
  same release train**. Nightcore does not currently emit `on-failure`, so nothing is
  broken today — but this is direct evidence that pinning `@openai/codex-sdk` does
  *not* pin app-server wire behaviour.
- **A new `granular` policy exists** —
  `{ sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations }`
  — gated behind `InitializeCapabilities.experimentalApi: true`. It would let a client
  choose *which* gates fire (including switching MCP gating off), which is genuinely
  interesting for a future governance design. It is also, by construction, the least
  stable surface in the protocol.

### 7.4 Field-level drift in the approval params

`CommandExecutionRequestApprovalParams` has grown since the 0.144.1 capture:
`approvalId` (nullable; disambiguates multiple callbacks under one `itemId` for the
zsh-exec-bridge), `networkApprovalContext`, and `proposedNetworkPolicyAmendments`.
`CommandExecutionApprovalDecision` gained an `applyNetworkPolicyAmendment` variant.
Additive so far — but it confirms the surface is still moving.

### 7.5 One documented field disappeared

The 0.144.1 spike recorded `thread/start` exposing `permissions?: string` (the
`[permissions.<profile>]` system). **0.145.0's `ThreadStartParams` has no
`permissions` field.** The undocumented per-path `Deny` system that spike explored as
a possible `protectedPaths` shortcut is no longer reachable that way — reinforcing
its conclusion that it is not something to build on.

## 8. Upstream feature request — DRAFTED, NOT FILED

Per the task, this is text for the maintainer to send (repo: `openai/codex`).

> **Title:** Expose an approval callback on the TypeScript SDK's `Thread.runStreamed()`
>
> **Body:**
>
> `codex app-server --stdio` exposes real, synchronous, pre-execution approval
> requests — `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
> and (via `mcpServer/elicitation/request` with `_meta.codex_approval_kind:
> "mcp_tool_call"`) MCP tool calls. A client answers `accept`/`decline` before the
> action runs. We verified against codex-cli 0.145.0 that declining genuinely blocks:
> the command never spawns a process, the patch is never applied, and a declined MCP
> tool call never reaches the MCP server.
>
> `@openai/codex-sdk` has no equivalent. `CodexExec` spawns `codex exec
> --experimental-json`, writes the prompt to stdin and immediately calls
> `stdin.end()`; `TurnOptions` is `{ outputSchema?, signal? }`. `approvalPolicy` is
> serialized to a static `--config approval_policy=…` flag, so any policy that can
> raise an approval request has no channel to answer it — the SDK is only usable with
> `approval_policy: "never"`.
>
> **Request:** add an optional approval handler to `ThreadOptions`/`TurnOptions`, e.g.
>
> ```ts
> type ApprovalRequest =
>   | { kind: 'commandExecution'; command: string; cwd: string; commandActions?: CommandAction[] }
>   | { kind: 'fileChange'; changes: { path: string; kind: string }[] }
>   | { kind: 'mcpToolCall'; server: string; tool: string; arguments: unknown };
>
> type TurnOptions = {
>   outputSchema?: unknown;
>   signal?: AbortSignal;
>   onApprovalRequest?: (req: ApprovalRequest) => Promise<'accept' | 'decline'> | 'accept' | 'decline';
> };
> ```
>
> **Why it matters:** embedders that must enforce their own policy (protected paths,
> denied command patterns, per-tool allow/deny tiers) currently have to abandon the
> versioned, typed npm SDK and hand-roll a JSON-RPC client against a protocol
> explicitly labelled experimental. That is a large amount of duplicated,
> drift-exposed client code for what the daemon already implements. Two concrete
> stability data points from our testing: the approval method names changed between
> our 2026-07 research and codex-cli 0.144.1, and on 0.145.0 `thread/start` now
> **rejects** `approval_policy: "on-failure"` (`unknown variant`) while
> `@openai/codex-sdk@0.145.0` still declares `"on-failure"` in `ApprovalMode` — so
> pinning the SDK does not pin the wire behaviour an embedder depends on.
>
> Two smaller asks that would help either way:
> 1. Include the MCP tool **name** as a structured field on the approval params
>    (today it is only in the human-readable `message`; `_meta` has `tool_params` and
>    `tool_description` but not the name).
> 2. Include the changed file paths on `item/fileChange/requestApproval` (today they
>    only appear on the preceding `item/started`, forcing clients to buffer and join
>    on `itemId`).

## 9. Recommendation: KEEP the #296 fail-closed refuse. Do NOT re-architect now.

The spike **strengthens** the technical case for Option B (MCP tool calls turn out to
be gated, and the write-enforcement bypass turns out not to exist) while leaving the
cost and the risk exactly where the maintainer's 2026-07-12 DEFER put them. Specifically:

**What improved.** The coverage ceiling is higher than #304 assumes. `disallowedTools`
/ `askTools` entries targeting `mcp__server__*` are enforceable after all (§6); every
mutating shell command and every patch is gated (§5.1); bypassed commands are still
fully observable for the ledger (§5.2). The reachable parity is roughly: full
enforcement on writes, patches, and MCP tool calls; observe-only on non-mutating reads.

**What did not improve, and what got worse.**

1. **The cost is unchanged.** It is still a full turn-driver rewrite —
   `thread/start`/`turn/start`/`turn/interrupt` replacing `runStreamed()` and
   `AbortController`, a new event-translation layer for the `item/*` vocabulary, plus
   the `itemId`-join buffering that §3 and §6.1 now show is *mandatory*, not optional.
2. **Protocol risk went up, not down.** §7.3 is a live breaking change on the exact
   field an Option B client must set, and — worse — a **divergence between the pinned
   npm SDK's declared types and the daemon's accepted values inside the same version**.
   The mitigation ("pin the SDK, the binary ships in the same train") that made this
   risk feel bounded is now demonstrably not sufficient.
3. **A new product-surface objection appeared.** §2.4: driving `thread/start` writes
   `trust_level = "trusted"` for the task's cwd into the user's global
   `~/.codex/config.toml` — Nightcore would silently mutate a user config file outside
   its own directories on every Codex task. That needs its own design decision.
4. **The safety urgency is still zero.** Governed Codex runs are refused today, not
   silently ungoverned. Nothing here changes that.

**Concrete proposal.**

- Keep #304 open, keep it DEFERRED, and update its body: strike the "no MCP approval
  event" limit (refuted), and re-scope the trusted-command limit from "governance is
  unenforceable" to "reads are un-vetoable and audit is post-hoc; writes are fully
  enforceable".
- Send the §8 upstream request. If `onApprovalRequest` lands on
  `Thread.runStreamed()`, Option B collapses from a turn-driver rewrite to an adapter
  that maps three request shapes onto `evaluateHarnessPolicy` / `evaluateToolDeny` /
  `SessionLedger` — which the existing provider-neutral policy code already supports
  unchanged. That is the outcome worth waiting for.
- Re-run this spike (§2 is deliberately re-runnable) before any future greenlight;
  §7.3 is the reason.

### 9.1 The governance guarantees Codex still cannot match, quantified

| Guarantee | Claude (`PreToolUse`) | Codex `app-server` on 0.145.0 |
|---|---|---|
| Every tool call passes a client-answerable gate | yes, no exceptions | **no** — 4/6 representative commands and 1/2 Harness-relevant commands bypassed (§5) |
| `protectedPaths` **write** deny | yes | **yes** (patch + mutating shell both gated, §4, §5.1) |
| `protectedPaths` **read** deny | yes | **NO — structurally impossible.** `cat .env` is classified `"read"` and auto-runs with the path already known to the classifier (§5) |
| `denyBashPatterns` | yes | **yes** for mutating commands; **no** for anything the classifier calls read-only |
| `disallowedTools` / `askTools` on `mcp__*` | yes | **yes** (§6) — previously believed impossible |
| Ledger record for every tool call | pre-execution | **post-hoc for bypassed commands**, pre-execution for gated ones (§5.2) |
| Enforced regardless of permission mode | yes (fires even under `bypassPermissions`) | n/a — requires `approvalPolicy != "never"`, which changes turn behaviour |

The single irreducible gap is the **read** row. Everything else is either reachable or
degrades to post-hoc audit rather than to nothing.

## 10. Traps any future build must handle

- **`approvalsReviewer: "user"` must be pinned explicitly** on `thread/start`.
  `"auto_review"` / `"guardian_subagent"` route decisions to Codex's own internal
  reviewer and approval requests silently stop reaching the client. (Carried forward
  from the 0.144.1 spike; the field is still present and still defaults are not to be
  trusted.)
- **Decision vocabularies differ per channel**: `accept|decline|cancel` (+
  `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`)
  for command execution; `accept|acceptForSession|decline|cancel` for file changes;
  `{ action: accept|decline|cancel, content }` for MCP elicitation. The legacy
  `approved`/`denied` strings are a different, non-firing surface.
- **`availableDecisions` is not the full set.** The live command-execution frame
  advertises `["accept", {acceptWithExecpolicyAmendment…}, "cancel"]` — `decline` is
  absent from the list yet is accepted and is what actually blocks. Do not derive the
  client's decision set from that field.
- **`item/fileChange/requestApproval` has no paths; MCP approvals have no tool name
  and no `itemId`.** Both require buffering `item/started` and joining. (§3, §6.1)
- **`thread/start` writes to `~/.codex/config.toml`.** (§2.4)
- **The `granular` policy needs `initialize.capabilities.experimentalApi: true`**, and
  opting into `experimentalApi` also changes which methods/fields the server exposes.

## 11. Bonus: the Codex hooks system is NOT a shortcut (checked, closed)

codex-cli 0.145.0 ships a Claude-Code-shaped hooks system —
`HookEventName = preToolUse | permissionRequest | postToolUse | …`, a
`hookSpecificOutput.permissionDecision` contract, `HookRunStatus` including
`"blocked"`, and payload fields `tool_name` / `tool_input` / `tool_use_id`. On its
face this looks like a far cheaper Option D: keep `Thread.runStreamed()` and get
`PreToolUse` governance from a config file. **It does not work, for a good reason.**

Hooks carry a `trustStatus`, and only trusted hooks execute. Both injection paths
reachable from Nightcore land `untrusted`:

```
# via the -c passthrough Nightcore already uses for mcp_servers
- preToolUse  source=sessionFlags  enabled=true  trust=untrusted  path=/<session-flags>/config.toml
# via a repo-local .codex/config.toml
- preToolUse  source=project       enabled=true  trust=untrusted  path=/…/ws-hook/.codex/config.toml
```

Live confirmation on the **`codex exec` path the SDK actually drives** — a hook
scripted to log its payload and deny anything matching `hook-victim`:

- with the hook injected via `-c hooks.PreToolUse=[…]`: `hook-victim.txt` **was
  created**, and the hook's payload log was never written — the hook never ran.
- with the same hook in a repo-local `.codex/config.toml`: identical result.

Adding `trusted_hash = "<currentHash from hooks/list>"` to the matcher group did not
flip the status. Only the user's own `~/.codex/hooks.json` reports `trust=trusted`
and actually executes. Trust elevation appears to require an interactive or
managed-config path not reachable from a flag — which is correct security design by
upstream (otherwise any `-c` flag could inject arbitrary command execution), and it
means this is **not** a governance seam Nightcore can use. Recorded so nobody
re-discovers the hooks system and assumes it is the cheap answer.

## 12. Reference files (not modified by this spike)

- `packages/engine/src/providers/codex/codex-agent-provider.ts` — `CodexSession`,
  still `Thread.runStreamed()`-driven. Unchanged.
- `packages/engine/src/providers/codex/options.ts` — `codexPostureForAutonomy()`'s
  "DEADLOCK INVARIANT" docblock remains accurate for the SDK path.
- `packages/engine/src/providers/codex/model-catalog.ts` — the existing
  `codex app-server --stdio` JSON-RPC client the spike harness mirrors.
- `packages/engine/src/providers/codex/capabilities.ts` —
  `providesOwnWriteContainment: true`; note §6, which shows it does not cover MCP
  tool calls.
- `packages/engine/src/policy/{harness-policy,tool-deny-policy,exec-sink}.ts`,
  `packages/engine/src/session/session-ledger.ts` — provider-neutral, reusable
  unchanged by any future adapter.
- `docs/research/2026-07-12-codex-governance-feasibility.md`,
  `docs/research/2026-07-12-codex-governance-spike.md` — the documents this one
  updates. Where they disagree with this one, this one is newer and was measured
  against 0.145.0.

## 13. Open questions

- Does the `granular` approval policy (behind `experimentalApi`) let a client keep
  MCP + file-change gating while dropping the read-classifier round trips entirely?
  Not tested — it needs the experimental capability, which also changes the rest of
  the method surface.
- What is the latency cost of the approval round trip on a realistic multi-step turn?
  This spike measured correctness, not turn-loop timing. The original feasibility
  doc's deadlock-avoidance concern remains unanalysed.
- How is hook `trustStatus` elevated to `trusted` for a non-`~/.codex` source? Only
  needed if §11 is ever revisited.
- `item/permissions/requestApproval` (new in 0.145.0) was not exercised live; its
  trigger conditions (sandbox escape / permission escalation) are unmapped.
