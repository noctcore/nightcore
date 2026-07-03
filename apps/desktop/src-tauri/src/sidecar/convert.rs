//! The shared convert-a-scan-item-into-a-board-task protocol.
//!
//! Insight findings, Scorecard readings, and Harness convention-findings + proposals all
//! convert into board Build tasks through the SAME mint-first / atomic-CAS / rollback
//! dance. This module is the ONE audited implementation of that protocol (it previously
//! lived as five near-identical hand-copies across `insight.rs`, `scorecard.rs`, and
//! `harness/commands.rs`). Each feature's `#[tauri::command]` wrapper now only:
//!   1. looks up its item and builds the fresh Task (title/description/kind/verify), then
//!   2. calls [`convert_to_task`] with two store-specific closures — the atomic link and
//!      the dangling-link repoint — and
//!   3. emits its own feature-specific `*-converted` notice on the store-stamped task.
//!
//! Keeping the concurrency-critical dance in one place means the invariants below are
//! audited once, not five times.

use crate::store::insight::LinkOutcome;
use crate::store::TaskStore;
use crate::task::Task;

/// Run the shared convert-to-task protocol against `store`, returning the store-stamped
/// task the caller should emit (the snapshot carries the assigned `seq`, so emitting it —
/// not the caller's pre-upsert `task` — keeps the wire event from being dropped as stale).
///
/// - `linked_task_id` is the item's current link, for fast-path idempotency: a re-click on
///   an item already linked to a still-live task mints nothing and returns that task.
/// - `task` is the freshly built (not-yet-persisted) task to mint.
/// - `link` performs the item's ATOMIC compare-and-set link (stamping it `converted` +
///   linked), returning [`LinkOutcome`]. This CAS — not the fast-path check — is the real
///   guard against two concurrent converts minting two tasks.
/// - `repoint` UNCONDITIONALLY re-points the item at `task.id`; it is called only to heal a
///   dangling link (the previously linked task was deleted out from under a lost race). It
///   must NOT be the CAS `link`, which would early-return `AlreadyLinked` again and never
///   heal the link.
///
/// The task is minted BEFORE linking so a crash between the two leaves a retryable unlinked
/// item, never an item pointing at a task that was never created. A lost CAS race
/// (`AlreadyLinked`) or a link error both roll back the duplicate task we just minted.
pub fn convert_to_task<L, R>(
    store: &TaskStore,
    linked_task_id: Option<&str>,
    task: Task,
    link: L,
    repoint: R,
) -> Result<Task, String>
where
    L: FnOnce(&str) -> Result<LinkOutcome, String>,
    R: FnOnce(&str) -> Result<(), String>,
{
    // Fast-path idempotency: an item already linked to a still-existing task returns it
    // without minting anything (covers the common re-click).
    if let Some(existing_id) = linked_task_id {
        if let Some(existing) = store.get(existing_id) {
            return Ok(existing);
        }
    }

    // Mint FIRST (a crash before linking leaves a retryable unlinked item), then link
    // ATOMICALLY.
    let stamped = store.upsert(&task)?;

    match link(&task.id) {
        Ok(LinkOutcome::Linked) => {}
        Ok(LinkOutcome::AlreadyLinked(existing_id)) => {
            // Another convert won the race (or a prior link survived). Discard the
            // duplicate task we just minted and return the existing one if it lives.
            let _ = store.remove(&task.id);
            if let Some(existing) = store.get(&existing_id) {
                return Ok(existing);
            }
            // The linked task was deleted out from under us: re-point the item at the task
            // we just (re)created instead of leaving a dangling link. Return the RE-upsert's
            // snapshot — not the stale pre-remove `stamped` — so the emitted task carries the
            // current stored `seq` (the emit-the-stamped-snapshot invariant this module
            // guarantees; a stale seq would let the web reconciler drop the healed event).
            let restamped = store.upsert(&task)?;
            repoint(&task.id)?;
            return Ok(restamped);
        }
        Err(e) => {
            // Linking failed (run/item vanished): roll back the orphan task so a retry is
            // clean rather than leaving an unlinked board task behind.
            let _ = store.remove(&task.id);
            return Err(e);
        }
    }

    Ok(stamped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tempfile::TempDir;

    fn store() -> (TaskStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        (TaskStore::load_from(tmp.path().join("tasks")), tmp)
    }

    #[test]
    fn mints_and_links_on_the_happy_path() {
        let (store, _tmp) = store();
        let task = Task::new("Adopt convention".into(), "body".into());
        let id = task.id.clone();
        let linked = Cell::new(false);

        let stamped = convert_to_task(
            &store,
            None,
            task,
            |task_id| {
                assert_eq!(task_id, id);
                linked.set(true);
                Ok(LinkOutcome::Linked)
            },
            |_| panic!("repoint must not run on the happy path"),
        )
        .unwrap();

        assert!(linked.get(), "the link closure must run");
        assert!(stamped.seq > 0, "the emitted task must carry a stamped seq");
        assert!(store.get(&stamped.id).is_some(), "the task must persist");
    }

    #[test]
    fn fast_path_returns_the_live_linked_task_without_minting() {
        let (store, _tmp) = store();
        let existing = store
            .upsert(&Task::new("Existing".into(), "body".into()))
            .unwrap();

        let out = convert_to_task(
            &store,
            Some(&existing.id),
            Task::new("Duplicate".into(), "body".into()),
            |_| panic!("link must not run when the fast-path hits"),
            |_| panic!("repoint must not run when the fast-path hits"),
        )
        .unwrap();

        assert_eq!(out.id, existing.id, "must return the already-linked task");
    }

    #[test]
    fn lost_race_rolls_back_the_duplicate_and_returns_the_winner() {
        let (store, _tmp) = store();
        let winner = store
            .upsert(&Task::new("Winner".into(), "body".into()))
            .unwrap();
        let loser = Task::new("Loser".into(), "body".into());
        let loser_id = loser.id.clone();

        let out = convert_to_task(
            &store,
            None,
            loser,
            |_| Ok(LinkOutcome::AlreadyLinked(winner.id.clone())),
            |_| panic!("repoint must not run when the winner still lives"),
        )
        .unwrap();

        assert_eq!(out.id, winner.id, "must return the race winner");
        assert!(
            store.get(&loser_id).is_none(),
            "the duplicate task must be rolled back"
        );
    }

    #[test]
    fn dangling_link_heals_by_repointing_at_the_minted_task() {
        let (store, _tmp) = store();
        let task = Task::new("Heal me".into(), "body".into());
        let id = task.id.clone();
        let repointed = Cell::new(false);

        let out = convert_to_task(
            &store,
            None,
            task,
            // The item claims it's already linked, but the linked task is gone.
            |_| Ok(LinkOutcome::AlreadyLinked("deleted-task".into())),
            |task_id| {
                assert_eq!(task_id, id);
                repointed.set(true);
                Ok(())
            },
        )
        .unwrap();

        assert!(repointed.get(), "repoint must heal the dangling link");
        assert_eq!(out.id, id, "must return the freshly minted task");
        let stored = store.get(&id).expect("the minted task must persist");
        // Regression: the heal path must return the RE-upsert's fresh snapshot, not the
        // stale pre-remove one — so the emitted task carries the current stored `seq` and
        // the web's seq-based reconciler can't drop the healed event as stale.
        assert_eq!(
            out.seq, stored.seq,
            "the healed task must carry the current stored seq, not a stale pre-remove one"
        );
    }

    #[test]
    fn link_error_rolls_back_the_orphan_task() {
        let (store, _tmp) = store();
        let task = Task::new("Orphan".into(), "body".into());
        let id = task.id.clone();

        let err = convert_to_task(
            &store,
            None,
            task,
            |_| Err("run vanished".into()),
            |_| panic!("repoint must not run on a link error"),
        )
        .unwrap_err();

        assert_eq!(err, "run vanished");
        assert!(
            store.get(&id).is_none(),
            "a link error must leave no orphan task behind"
        );
    }
}
