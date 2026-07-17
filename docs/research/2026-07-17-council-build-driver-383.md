# Council write-capable single-writer Build driver + engine↔Rust worktree seam (#383)

**Status:** implemented · **Risk:** highest in the Council feature (first autonomous code
_write_) · **Closes:** #383

This is the slice that makes a build-capable Council actually WRITE code, not just reason.
Everything that makes writing safe already existed and is REUSED; the only genuinely new
surface is one thin, path-less, `councilRunId`-keyed RPC verb-set letting the in-engine
Council reach Rust's already-audited `crate::worktree` + Structure-Lock gauntlet across the
sidecar process boundary.

## The one new surface — a path-less, councilRunId-keyed RPC

The engine (Bun sidecar, TS) and `crate::worktree` (Rust host) are DIFFERENT PROCESSES over
NDJSON. The seam is modeled EXACTLY on the parked-permission seam
(`permission-required` → host acts → resolving `approve-permission`):

| Direction | Message | Contract |
|---|---|---|
| engine → host | `worktree-op-required { requestId, op, councilRunId }` | `packages/contracts/src/debate.ts` (`WorktreeOpRequiredEvent`, `WorktreeOpKind = allocate \| commit \| gauntlet`) |
| host → engine | `resolve-worktree-op { requestId, worktreePath?, gauntletPassed?, gauntletSummary?, error? }` | `packages/contracts/src/commands.ts` (`ResolveWorktreeOpCommand`) |

- **Engine side.** `WorktreeOpBroker` (`packages/engine/src/debate/worktree-rpc.ts`) is the
  correlation registry (`Map<requestId, resolver>`, mirroring the SDK question layer): it
  mints a `requestId`, registers a resolver, emits the event onto the same supervisor sink
  `debate-entry` rides, and returns a Promise. The `CouncilRouter` routes the incoming
  `resolve-worktree-op` command to `broker.resolve`. It NEVER rejects — an abort (kill /
  budget) or a reply timeout settles the Promise with `{ error }` so the caller fails CLOSED.
- **Host side.** `apps/desktop/src-tauri/src/sidecar/reader.rs` routes `worktree-op-required`
  BEFORE the session-id correlation (it carries no `sessionId`, like `debate-*`), consumes it
  internally (rides no `nc:*` channel), and offloads it to
  `sidecar/council_worktree.rs::handle_worktree_op` on the blocking pool (git/gauntlet block).

### SECURITY-CRITICAL — the host derives every path; the engine sends none

The request carries only a **closed `op` verb + the `councilRunId`** — no path. The host maps
that id, via the `CouncilRunRegistry` the WEBVIEW populated at `start-council`, to the TRUSTED
project root it recorded, and derives the worktree with `crate::worktree::worktree_path`
(`.nightcore/worktrees/<runId>`, guarded by `path::is_under`). An UNKNOWN or non-build-capable
(`research`) run id resolves to **no path at all** and is refused. This is what makes the seam
add a MESSAGE TYPE, not a write/exec sink: an injection-compromised engine can name a verb + a
run id but can NEVER redirect an op outside the run's own isolated worktree.

- Registry: `sidecar/council_worktree.rs::CouncilRunRegistry` (managed in `lib.rs`), written by
  `start_council` (register), `resolve_council_converge` / `kill_council` (forget).
- Gate: `build_project_path(run_id)` returns `Some(project_root)` ONLY for a registered,
  build-capable run — the sole source of the project root for every op.

## Reuse table — nothing new for any of these

| Confinement guarantee | Reused module | New? |
|---|---|---|
| Worktree isolation + escape guard | `worktree::{allocate, commit, worktree_path, is_under}` | no |
| Commit single-flight | `workflow::merge::{TaskLease, commit_in_flight}` | no |
| git env isolation | `platform::git_command` (inside `worktree::*`) | no |
| Structure-Lock gauntlet (manifest-trust split) | `gauntlet_project::run_from(project_root, worktree)` | no |
| PreToolUse workspace confinement | `evaluateWorkspaceConfinement` (auto-scopes to the writer cwd) | no |
| Seatbelt write sandbox | `prepareWriteSandbox` / `deriveWritableRoots` (from `sandboxWrites:true` + cwd) | no |
| Write-capable session spawn | `SessionSeatDriver.runWriterTurn` + `BUILD_WRITER_HARDENING` | no |
| Objective-gate override | `gauntletObjectiveGate` / `objectiveGateForPreset` | no |
| **engine↔host worktree RPC** | modeled on the parked-permission seam | **YES — the only new seam** |

## Where the writer runs (no new spawn path)

`SessionSeatDriver` gained `runWriterTurn`, which reuses the EXACT spawn/correlate/teardown
core of `runTurn` but stamps `BUILD_WRITER_HARDENING` (`auto-accept` — write-capable, prompt
suppressed — with the OS write sandbox STILL on, deliberately NOT `bypass`) and runs with
`cwd` = the allocated worktree. Every debating seat stays on `runTurn`'s read-only `plan`
posture; only the conductor-elected single writer (`electWriter(debatingSeats(...))`, never a
judge) reaches `runWriterTurn`, via `SessionBuildDriver`.

## The Build flow

1. `SessionBuildDriver.build` requests `allocate` → the host-derived worktree path. **Fails
   CLOSED** (throws → run `failed`) if allocation fails, so nothing un-built is ever judged.
2. Runs the elected writer write-capable-but-sandboxed with `cwd` = that worktree.
3. Requests `commit` (best-effort) so the `nc/<runId>` branch has the writer's edits for the
   human to merge — NEVER a merge. A failed commit does not fail the build (the gate judges the
   working tree regardless).
4. Returns the worktree; at Converge the gauntlet runner requests `gauntlet`, and a RED verdict
   OVERRIDES consensus (safety #6). Merge / discard stay HUMAN-only through the existing
   `merge_task` / `discard_worktree` paths.

## Deliberate deviation — the gate exec runs Rust-side, not in the engine

The design map specified binding the harness `runChecks` engine-side. I route the gate through
the host `gauntlet` verb instead, and it was a deliberate, security-motivated choice:

- **No new exec sink** (the primary directive). It reuses the board's audited
  `gauntlet_project::run_from` verbatim — the manifest-trust split (manifest from the TRUSTED
  project root, checks in the worktree), the `command_guard` shape validation, the retry /
  security-critical policy. Adding a `spawnSync` gauntlet in the engine would have been a brand
  new exec capability in the engine process.
- **Closes the writer-tampered-manifest RCE.** Because the manifest is loaded from the project
  root (not the worktree), the write-capable writer cannot redefine which checks run.
- **Fully path-less.** The engine sends only `op: 'gauntlet'` + the run id; the host derives
  BOTH the manifest root and the run dir — consistent with the seam's security model.
- Avoids a cross-scope `@nightcore/engine → @noctcore/harness` runtime dependency and a change
  to the published harness package surface.

Note: the gauntlet executes writer-authored code in the worktree (e.g. `bun test` runs the
worktree's test files). This is a **pre-existing accepted risk** identical to the board's
worktree gate — the OS sandbox is on the SESSION, the gauntlet is a separate deterministic
check that runs unsandboxed in both the board and the council. #383 does not widen it.

## Live-confinement test coverage — automated vs. manual

**Automated (exercise the REAL functions, not stubs):**
- Writer cannot escape its worktree — `evaluateWorkspaceConfinement` DENIES out-of-worktree
  Write/Edit, Bash redirects, and `.git/config` (council-safety.test.ts).
- Seatbelt writable roots = worktree (+ git common / scratch), never the project root at large
  — `deriveWritableRoots` (council-safety.test.ts).
- Exactly one writer, from debaters — `electWriter` / "elected from DEBATERS only" +
  end-to-end with the real `SessionBuildDriver` (one proposer writer, in the worktree).
- RED gate rejects / GREEN lets consensus stand / human override audited — the real driver +
  gauntlet runner + broker driven through the Conductor (council-safety.test.ts) and the router
  (council-router.test.ts, allocate → commit → gauntlet round-trip).
- Dormancy unchanged — `research` injects the real driver/gauntlet yet emits ZERO worktree ops.
- RPC path-injection refused — the host derives from `councilRunId`, refuses unknown / foreign /
  `../` ids (Rust: `sidecar/council_worktree.rs` tests) + the request event is PATH-LESS
  (worktree-rpc.test.ts).

**Needs manual live verification (exceeds CI):** a real Claude session physically writing to
disk and _attempting_ to escape its worktree. The driver seam stays exec-neutral in tests (a
fake `runWriter` / a fake host reply), while the confinement FUNCTIONS the real session is
bound to are asserted directly. A dogfood run of a `ui-bug` / `coding` council on a repo with a
`.nightcore/harness.json` is the end-to-end check.

## Follow-ups (out of scope)

- Dep-provisioning of the council worktree before the gauntlet (a missing-deps gate fails safe
  = RED / parked, so this is a usefulness nicety, not a safety gap).
- The deferred #367/#366 hardening nits (Review-note coerce-to-enum, scan-and-block for the
  build plan) are tracked separately.
