//! The pr-fix wire state ([`PrFixState`]) and its in-memory registry
//! ([`PrFixRegistry`]).
//!
//! The registry is the arc's source of truth AND its long-running in-flight
//! guard: an entry with status `running` is what refuses a second concurrent fix
//! for the same PR (the `pr_in_flight` `TaskLease` only covers the setup/push
//! windows — see the module doc in `mod.rs`). Deliberately in-memory for v1: an
//! app restart loses the registry, but never the work — the fix session's edits
//! are auto-committed onto the PR branch in its checkout, so the user can push
//! by hand (or re-run the fix). The `push_pr_fix` not-found message names this.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use crate::sync::lock_or_recover;
use crate::task::now_ms;

/// Every pr-fix id carries this prefix, so a fix session's correlation id can
/// never collide with a task id (tasks are bare uuids).
pub(crate) const FIX_ID_PREFIX: &str = "prfix-";

/// The pr-fix lifecycle statuses (plain strings on the wire, like the scan
/// stores' run statuses — no enum fork for the UI to drift against).
pub(crate) const STATUS_RUNNING: &str = "running";
/// The completion claim: `handle_fix_completed` CAS-transitions `running →
/// committing` BEFORE its blocking auto-commit, so a cancel that lands after the
/// claim can't race the commit (a `committing` fix is past cancel — the commit
/// settles it to `awaiting_push`/`failed`).
pub(crate) const STATUS_COMMITTING: &str = "committing";
pub(crate) const STATUS_AWAITING_PUSH: &str = "awaiting_push";
pub(crate) const STATUS_PUSHED: &str = "pushed";
pub(crate) const STATUS_FAILED: &str = "failed";

/// Mint a fresh pr-fix id (`prfix-<uuid>`). The prefix keeps it disjoint from
/// task ids in the provider's session↔id correlation map, which is what lets the
/// reader intercept route a fix session away from the task-store paths.
pub(super) fn mint_fix_id() -> String {
    format!("{FIX_ID_PREFIX}{}", uuid::Uuid::new_v4())
}

/// One address-review-findings fix run: which PR/branch/checkout it works on and
/// where it is in the running → committing → awaiting_push → pushed lifecycle
/// (or `failed`). Emitted whole on `nc:pr-fix` on every change; `list_pr_fixes`
/// returns the full set for web reconcile.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrFixState.ts"))]
pub struct PrFixState {
    /// The fix id (`prfix-<uuid>`) — also the session's correlation id.
    pub id: String,
    /// The PR-review run the findings were selected from.
    pub run_id: String,
    /// The pull request being fixed.
    pub pr_number: u64,
    /// The PR head branch the checkout is on (validated ref; what gets pushed).
    pub branch: String,
    /// The checkout the fix session ran in (a task worktree, or the managed
    /// `.nightcore/pr-fix/pr-<n>` checkout).
    pub dir: String,
    /// `running` | `committing` | `awaiting_push` | `pushed` | `failed`.
    pub status: String,
    /// The fix session's final result text, once completed.
    pub summary: Option<String>,
    /// The failure reason, when `failed`.
    pub error: Option<String>,
    /// How many findings the fix prompt carried.
    pub finding_count: u32,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A registry entry: the wire state plus the `pr_in_flight` lease id its setup
/// used (the reusing task's id, or the managed `pr-<n>` key). The lease id is
/// registry-internal — `push_pr_fix` re-acquires the SAME id so a pr-fix push
/// stays mutually exclusive with the task-scoped PR actions on that checkout.
struct PrFixEntry {
    state: PrFixState,
    lease_id: String,
}

/// The in-memory pr-fix registry, managed in `lib.rs` (`app.manage(...)`).
/// See the module doc for the v1 restart-loss trade-off.
#[derive(Default)]
pub struct PrFixRegistry(Mutex<HashMap<String, PrFixEntry>>);

impl PrFixRegistry {
    /// Whether `id` names a registered fix — the reader intercept's routing probe.
    pub(crate) fn contains(&self, id: &str) -> bool {
        lock_or_recover(&self.0).contains_key(id)
    }

    /// One fix's state (cloned), if registered.
    pub(crate) fn get(&self, id: &str) -> Option<PrFixState> {
        lock_or_recover(&self.0).get(id).map(|e| e.state.clone())
    }

    /// The `pr_in_flight` lease id a fix's setup used, for `push_pr_fix` to
    /// re-acquire.
    pub(super) fn lease_id_for(&self, id: &str) -> Option<String> {
        lock_or_recover(&self.0).get(id).map(|e| e.lease_id.clone())
    }

    /// Every registered fix, newest first (for web reconcile).
    pub(crate) fn list(&self) -> Vec<PrFixState> {
        let mut states: Vec<PrFixState> = lock_or_recover(&self.0)
            .values()
            .map(|e| e.state.clone())
            .collect();
        states.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        states
    }

    /// The RUNNING fix (if any) whose session works a task's checkout: matched by
    /// the task's PR number when it tracks one, OR by the setup's lease id (the
    /// reusing task's own id) — whichever key the caller holds. `committing`
    /// counts as running here: the fix session just ended but its auto-commit is
    /// still mutating the checkout. The merge/finalize/push cross-guards and the
    /// dispatch guard consume this.
    pub(crate) fn running_for_task(
        &self,
        pr_number: Option<u64>,
        task_id: &str,
    ) -> Option<PrFixState> {
        lock_or_recover(&self.0)
            .values()
            .find(|e| {
                is_live(&e.state.status)
                    && (pr_number == Some(e.state.pr_number) || e.lease_id == task_id)
            })
            .map(|e| e.state.clone())
    }

    /// The RUNNING (or `committing`) fix whose checkout dir is `dir`, if any —
    /// the orchestration dispatch guard's probe (a task must not launch into a
    /// worktree a live fix session is editing).
    pub(crate) fn running_for_dir(&self, dir: &std::path::Path) -> Option<PrFixState> {
        lock_or_recover(&self.0)
            .values()
            .find(|e| is_live(&e.state.status) && std::path::Path::new(&e.state.dir) == dir)
            .map(|e| e.state.clone())
    }

    /// The fix (if any) parked between completion and its human push gate for
    /// `pr_number` — `awaiting_push`, or `committing` (about to become
    /// awaiting_push). `push_pr_updates` refuses while one exists so a task-side
    /// push can't interleave with the fix's own pending push.
    pub(crate) fn pending_push_for_pr(&self, pr_number: u64) -> Option<PrFixState> {
        lock_or_recover(&self.0)
            .values()
            .find(|e| {
                e.state.pr_number == pr_number
                    && matches!(
                        e.state.status.as_str(),
                        STATUS_AWAITING_PUSH | STATUS_COMMITTING
                    )
            })
            .map(|e| e.state.clone())
    }

    /// The cheap early refusal for a duplicate fix on one PR. Advisory only —
    /// the ATOMIC guard is [`insert_running`](Self::insert_running), which
    /// re-checks under the same lock it inserts with; this exists so the command
    /// can refuse before spending the checkout/`gh` work. Mirrors the atomic
    /// guard's full exclusion set (running/committing/awaiting_push).
    pub(super) fn refuse_running_for_pr(&self, pr_number: u64) -> Result<(), String> {
        blocking_conflict(&lock_or_recover(&self.0), pr_number).map_or(Ok(()), Err)
    }

    /// Register a fresh `running` fix. Under ONE lock: refuses when another fix
    /// for the same PR is still `running`/`committing` (the duplicate-spend
    /// TOCTOU two racing commands would otherwise hit) or parked `awaiting_push`
    /// (its unpushed branch commit would be silently buried by a second fix on
    /// the same branch — push or dismiss it first), and on an id collision
    /// (paranoia — ids are uuids). A fix that reached `pushed`/`failed` never
    /// blocks a new one: the exclusion is one live-or-pending fix per PR, not
    /// history.
    pub(super) fn insert_running(&self, state: PrFixState, lease_id: &str) -> Result<(), String> {
        let mut map = lock_or_recover(&self.0);
        if let Some(conflict) = blocking_conflict(&map, state.pr_number) {
            return Err(conflict);
        }
        if map.contains_key(&state.id) {
            return Err(format!("a PR fix with id {} already exists", state.id));
        }
        map.insert(
            state.id.clone(),
            PrFixEntry {
                state,
                lease_id: lease_id.to_string(),
            },
        );
        Ok(())
    }

    /// Remove a SETTLED fix from the registry — the `dismiss_pr_fix` seam for
    /// clearing a stale `awaiting_push`/`pushed`/`failed` entry (e.g. so a new
    /// fix for the PR can start). Refuses a `running`/`committing` fix: a live
    /// session/commit must be cancelled (or allowed to finish), never orphaned
    /// by dropping its registry entry.
    pub(super) fn remove_settled(&self, id: &str) -> Result<PrFixState, String> {
        let mut map = lock_or_recover(&self.0);
        let entry = map
            .get(id)
            .ok_or_else(|| format!("no PR fix with id {id}"))?;
        if is_live(&entry.state.status) {
            return Err(format!(
                "this fix is still {} — cancel it (or wait for it to finish) before dismissing",
                entry.state.status
            ));
        }
        Ok(map.remove(id).expect("entry existed under this lock").state)
    }

    /// Transition one fix's state, REQUIRING its current status to be `from`
    /// (the state-machine guard: a push can't stamp `pushed` over `failed`, a
    /// late completion can't resurrect a cancelled fix). Applies `f`, stamps
    /// `updated_at`, and returns the updated state for the caller to emit.
    pub(super) fn transition(
        &self,
        id: &str,
        from: &str,
        f: impl FnOnce(&mut PrFixState),
    ) -> Result<PrFixState, String> {
        let mut map = lock_or_recover(&self.0);
        let entry = map
            .get_mut(id)
            .ok_or_else(|| format!("no PR fix with id {id}"))?;
        if entry.state.status != from {
            return Err(format!(
                "PR fix {id} is not {from} (status: {})",
                entry.state.status
            ));
        }
        f(&mut entry.state);
        entry.state.updated_at = now_ms();
        Ok(entry.state.clone())
    }

    /// Mark a fix failed IF it is still running; `None` when it is unknown or
    /// already terminal. The tolerant shape makes the cancel path idempotent
    /// against the session's own later `session-failed (aborted)` terminal:
    /// whichever lands first transitions, the other is a silent no-op.
    pub(super) fn mark_failed_if_running(&self, id: &str, error: String) -> Option<PrFixState> {
        self.transition(id, STATUS_RUNNING, |s| {
            s.status = STATUS_FAILED.to_string();
            s.error = Some(error);
        })
        .ok()
    }
}

/// Refuse a task-scoped terminal action (merge / finalize / push updates) while
/// a LIVE fix session (running, or committing its results) works this task's
/// checkout — matched by the task's PR number and/or the task id the fix's
/// setup leased. The message names the fix so the user can cancel it from the
/// PR workspace. The sibling of `refuse_while_pr_in_flight` for the fix arc's
/// LONG window (the `pr_in_flight` lease only covers setup/push).
pub(crate) fn refuse_while_fix_running(
    registry: &PrFixRegistry,
    pr_number: Option<u64>,
    task_id: &str,
    before_what: &str,
) -> Result<(), String> {
    if let Some(fix) = registry.running_for_task(pr_number, task_id) {
        return Err(format!(
            "a PR fix ({}) for PR #{} is running in this task's checkout — wait for it to \
             finish or cancel it before {before_what}",
            fix.id, fix.pr_number
        ));
    }
    Ok(())
}

/// Refuse a task-side `push_pr_updates` while a fix for the PR sits at (or is
/// about to reach) its own human push gate: pushing the branch out from under
/// the gate would ship the fix's commit without the user's explicit approval —
/// push or dismiss the fix first.
pub(crate) fn refuse_while_fix_pending_push(
    registry: &PrFixRegistry,
    pr_number: u64,
) -> Result<(), String> {
    if let Some(fix) = registry.pending_push_for_pr(pr_number) {
        return Err(format!(
            "a fix ({}) for PR #{} is awaiting its own push gate — push or dismiss it from \
             the PR workspace first",
            fix.id, fix.pr_number
        ));
    }
    Ok(())
}

/// Whether a status names a LIVE fix — a running session or its in-flight
/// auto-commit — the states the cross-action guards treat as "a fix session is
/// using this checkout".
fn is_live(status: &str) -> bool {
    matches!(status, STATUS_RUNNING | STATUS_COMMITTING)
}

/// The refusal (if any) a new fix for `pr_number` hits: a live fix (running/
/// committing), or one parked `awaiting_push`. Shared by the advisory pre-check
/// and the atomic insert so the two can never drift. The caller holds the lock.
fn blocking_conflict(map: &HashMap<String, PrFixEntry>, pr_number: u64) -> Option<String> {
    map.values()
        .filter(|e| e.state.pr_number == pr_number)
        .find_map(|e| match e.state.status.as_str() {
            STATUS_RUNNING | STATUS_COMMITTING => Some(format!(
                "a fix for PR #{pr_number} is already running — wait for it to finish or cancel it first"
            )),
            STATUS_AWAITING_PUSH => Some(format!(
                "a fix for PR #{pr_number} is awaiting its push gate — push or dismiss it first"
            )),
            _ => None,
        })
}
