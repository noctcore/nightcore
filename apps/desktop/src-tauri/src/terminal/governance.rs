//! Persistent governance markers for user terminal sessions (#405).
//!
//! A terminal is **ungoverned** when it is task-linked or was used to launch
//! `claude`: it runs as the human, outside the gates, the flight recorder, and the
//! gauntlet. The UI bolts a warning marker onto such a tab.
//!
//! ## Why this file exists
//! That marker used to live ONLY in web-side module state (`@/lib/terminal-links`),
//! so it evaporated on every reload — and, in daemon mode, on every app restart, i.e.
//! precisely on the long-lived sessions where it matters most. The shell kept running
//! `claude`; the chrome went back to claiming an ordinary governed tab. **A marker
//! that disappears on restart is a marker that lies.** So the marker is now recorded
//! SERVER-SIDE, on disk, keyed by session id, and re-stamped onto every session
//! descriptor the backend hands out.
//!
//! ## Shape + invariants
//!  - One small JSON file, `<terminals dir>/governance.json`, versioned `v: 1` with
//!    every field `#[serde(default)]` (serde-additive, like the scrollback record).
//!    It rides the store's atomic write, so a crash never leaves a torn file.
//!  - A [`TerminalGovernanceReason`] is either **sticky** (`ClaudeLaunched` — a fact
//!    of history that can never be un-said while the record lives) or **revocable**
//!    (`TaskLinked` — clearing the task link drops it). [`unmark`] REFUSES a sticky
//!    reason rather than silently succeeding, so a caller bug is loud.
//!  - Read-modify-write is serialized process-wide by [`MARK_LOCK`]: two concurrent
//!    `spawn_blocking` marks can't lose one another's write.
//!  - Ids are validated with the same flat-token guard the scrollback filenames use
//!    (`persist::is_safe_session_id`) — a crafted id never becomes a map key.
//!
//! SECURITY: this file records only session ids + a reason enum. It never contains
//! shell output, commands, or paths, so it carries none of the scrollback's secret
//! risk.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use super::persist::{is_safe_session_id, now_ms};

/// The current on-disk schema version (bumped only on a breaking shape change).
const SCHEMA_VERSION: u32 = 1;

/// The marker file's name inside the project's terminals dir.
const FILE_NAME: &str = "governance.json";

/// Serializes the read-modify-write of the marker file across threads: every terminal
/// command runs on `spawn_blocking`, so two marks really can land concurrently, and a
/// lost update here would silently drop a governance marker.
static MARK_LOCK: Mutex<()> = Mutex::new(());

/// Why a terminal session is marked ungoverned. Serializes camelCase to the TS union
/// `"claudeLaunched" | "taskLinked"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TerminalGovernanceReason.ts"))]
pub enum TerminalGovernanceReason {
    /// The user ran the one-click "Launch Claude" affordance in this shell. STICKY:
    /// an agent ran here as the human — that is history, and history is not editable.
    ClaudeLaunched,
    /// A task's context was injected into this shell. REVOCABLE: clearing the link
    /// clears this reason (the session stays ungoverned if `claude` also ran).
    TaskLinked,
}

impl TerminalGovernanceReason {
    /// Whether [`unmark`] may remove this reason. `ClaudeLaunched` is deliberately
    /// NOT revocable — see the type docs.
    pub(crate) const fn revocable(self) -> bool {
        matches!(self, TerminalGovernanceReason::TaskLinked)
    }
}

/// One session's marker record.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SessionMark {
    /// The reasons in effect. Empty ⇒ the entry is dropped on write.
    #[serde(default)]
    reasons: Vec<TerminalGovernanceReason>,
    /// Epoch-ms of the FIRST mark (kept for future forensics; never used to expire a
    /// marker — an old live session must not silently become "governed").
    #[serde(default)]
    marked_at: u64,
}

/// The whole on-disk file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct GovernanceFile {
    #[serde(default = "default_version")]
    v: u32,
    #[serde(default)]
    marks: BTreeMap<String, SessionMark>,
}

impl Default for GovernanceFile {
    fn default() -> Self {
        Self {
            v: SCHEMA_VERSION,
            marks: BTreeMap::new(),
        }
    }
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// A loaded snapshot of every session's governance marks — the read side the backend
/// stamps descriptors from. Cheap to hold; re-loaded per `list()` so a mark written by
/// another window/thread is picked up without a cache-invalidation dance.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GovernanceMarks {
    marks: BTreeMap<String, SessionMark>,
}

impl GovernanceMarks {
    /// Whether `id` carries ANY governance reason (the wire's `ungoverned` bool).
    pub(crate) fn is_ungoverned(&self, id: &str) -> bool {
        self.marks.get(id).is_some_and(|m| !m.reasons.is_empty())
    }

    /// Every marked session id (the GC + test surface).
    #[cfg(test)]
    pub(crate) fn ids(&self) -> Vec<&str> {
        self.marks.keys().map(String::as_str).collect()
    }
}

fn file_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn read_file(dir: &Path) -> GovernanceFile {
    std::fs::read(file_path(dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<GovernanceFile>(&bytes).ok())
        .unwrap_or_default()
}

fn write_file(dir: &Path, file: &GovernanceFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create terminals dir: {e}"))?;
    let bytes = serde_json::to_vec(file).map_err(|e| format!("serialize governance: {e}"))?;
    crate::store::write_atomic(&file_path(dir), &bytes)
        .map_err(|e| format!("write governance markers: {e}"))
}

/// Load every persisted governance mark under `dir`. A missing / unparsable file is
/// an EMPTY snapshot, never an error — the marker is chrome, and a broken file must
/// not wedge the terminal (the fail-open here is deliberate and bounded: the worst
/// case is the pre-#405 behavior).
pub(crate) fn load(dir: &Path) -> GovernanceMarks {
    GovernanceMarks {
        marks: read_file(dir).marks,
    }
}

/// Record `reason` against `id`, persisted atomically. Idempotent (re-marking the same
/// reason is a no-op success) and additive (a second reason joins the first). Errors
/// on an unsafe id or an unwritable dir — the caller surfaces it.
pub(crate) fn mark(dir: &Path, id: &str, reason: TerminalGovernanceReason) -> Result<(), String> {
    if !is_safe_session_id(id) {
        return Err(format!("refusing to mark unsafe session id {id:?}"));
    }
    let _guard = MARK_LOCK.lock().map_err(|_| lock_poisoned())?;
    let mut file = read_file(dir);
    let entry = file.marks.entry(id.to_string()).or_default();
    if entry.marked_at == 0 {
        entry.marked_at = now_ms();
    }
    if entry.reasons.contains(&reason) {
        return Ok(());
    }
    entry.reasons.push(reason);
    entry.reasons.sort_unstable();
    write_file(dir, &file)
}

/// Remove `reason` from `id`'s marks. REFUSES a sticky reason (`ClaudeLaunched`):
/// once an agent has run as the human in a shell, no UI action may un-say it. A
/// session with no remaining reasons drops out of the file entirely. Removing a
/// reason that was never set is a no-op success.
pub(crate) fn unmark(dir: &Path, id: &str, reason: TerminalGovernanceReason) -> Result<(), String> {
    if !reason.revocable() {
        return Err(format!(
            "governance marker {reason:?} is permanent and cannot be cleared"
        ));
    }
    let _guard = MARK_LOCK.lock().map_err(|_| lock_poisoned())?;
    let mut file = read_file(dir);
    let Some(entry) = file.marks.get_mut(id) else {
        return Ok(());
    };
    let before = entry.reasons.len();
    entry.reasons.retain(|r| *r != reason);
    if entry.reasons.len() == before {
        return Ok(());
    }
    if entry.reasons.is_empty() {
        file.marks.remove(id);
    }
    write_file(dir, &file)
}

/// Drop every mark whose session id is absent from `keep` — the GC the restore UI's
/// list call drives, with `keep` = live ids ∪ persisted-scrollback ids. Deliberately
/// NOT age-based: a mark expiring under a still-running shell is exactly the lie this
/// module exists to kill. Best-effort; a write failure leaves the (superset) file.
pub(crate) fn retain(dir: &Path, keep: &HashSet<String>) {
    let Ok(_guard) = MARK_LOCK.lock() else {
        return;
    };
    let mut file = read_file(dir);
    let before = file.marks.len();
    file.marks.retain(|id, _| keep.contains(id));
    if file.marks.len() != before {
        let _ = write_file(dir, &file);
    }
}

fn lock_poisoned() -> String {
    "terminal governance lock poisoned".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dir(tmp: &TempDir) -> PathBuf {
        tmp.path().join("terminals")
    }

    #[test]
    fn a_mark_survives_a_restart_because_it_lives_on_disk() {
        // THE load-bearing case (#405). "Survives a restart" is only meaningful if the
        // marker actually LEFT the process, so this asserts the bytes on disk — a
        // process-global cache (what the web-side store effectively was) passes a
        // naive "write then read" test and fails this one.
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "sess-1", TerminalGovernanceReason::ClaudeLaunched).unwrap();

        let bytes = std::fs::read(file_path(&d))
            .expect("the marker is a file, not a memory the process could lose");
        assert!(
            String::from_utf8_lossy(&bytes).contains("sess-1"),
            "the file names the marked session"
        );

        // A cold directory holding nothing but those bytes still yields the marker —
        // the exact position a relaunched app or a restarted daemon starts from.
        let cold = tmp.path().join("cold");
        std::fs::create_dir_all(&cold).unwrap();
        std::fs::write(file_path(&cold), &bytes).unwrap();
        let after_restart = load(&cold);
        assert!(
            after_restart.is_ungoverned("sess-1"),
            "the ungoverned marker must outlive the process that wrote it"
        );
        assert!(
            !after_restart.is_ungoverned("sess-2"),
            "unmarked stays clean"
        );
    }

    #[test]
    fn marks_are_idempotent_and_additive() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        mark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        mark(&d, "s", TerminalGovernanceReason::ClaudeLaunched).unwrap();

        let file = read_file(&d);
        let entry = file.marks.get("s").expect("marked");
        assert_eq!(
            entry.reasons,
            vec![
                TerminalGovernanceReason::ClaudeLaunched,
                TerminalGovernanceReason::TaskLinked
            ],
            "both reasons, deduped + ordered"
        );
        assert!(entry.marked_at > 0, "the first mark stamps a time");
    }

    #[test]
    fn clearing_a_task_link_leaves_a_claude_launch_marked() {
        // The security-relevant composition: unlinking a task must not un-say that an
        // agent ran in this shell.
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        mark(&d, "s", TerminalGovernanceReason::ClaudeLaunched).unwrap();

        unmark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        assert!(
            load(&d).is_ungoverned("s"),
            "the claude-launch marker survives the unlink"
        );
    }

    #[test]
    fn a_sticky_marker_can_never_be_cleared() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "s", TerminalGovernanceReason::ClaudeLaunched).unwrap();

        let err = unmark(&d, "s", TerminalGovernanceReason::ClaudeLaunched)
            .expect_err("a sticky marker refuses to clear");
        assert!(err.contains("permanent"), "got: {err}");
        assert!(load(&d).is_ungoverned("s"), "and it is still marked");
    }

    #[test]
    fn clearing_the_last_revocable_reason_drops_the_entry() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        unmark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        assert!(!load(&d).is_ungoverned("s"));
        assert!(load(&d).ids().is_empty(), "no empty husk is left behind");
        // Unmarking an unknown id is a no-op success.
        unmark(&d, "ghost", TerminalGovernanceReason::TaskLinked).unwrap();
    }

    #[test]
    fn unsafe_session_ids_are_refused() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        let err = mark(&d, "../escape", TerminalGovernanceReason::TaskLinked).unwrap_err();
        assert!(err.contains("unsafe session id"), "got: {err}");
        assert!(load(&d).ids().is_empty());
    }

    #[test]
    fn retain_gcs_only_forgotten_sessions() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        mark(&d, "live", TerminalGovernanceReason::ClaudeLaunched).unwrap();
        mark(&d, "gone", TerminalGovernanceReason::TaskLinked).unwrap();

        retain(&d, &HashSet::from(["live".to_string()]));
        let after = load(&d);
        assert!(after.is_ungoverned("live"));
        assert!(!after.is_ungoverned("gone"));
    }

    #[test]
    fn a_missing_or_corrupt_file_loads_empty_instead_of_wedging() {
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        assert!(load(&d).ids().is_empty(), "no file ⇒ no marks");

        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(file_path(&d), b"{ not json").unwrap();
        assert!(load(&d).ids().is_empty(), "garbage ⇒ no marks, no panic");
        // And a subsequent mark heals the file.
        mark(&d, "s", TerminalGovernanceReason::TaskLinked).unwrap();
        assert!(load(&d).is_ungoverned("s"));
    }

    #[test]
    fn a_legacy_file_without_a_version_still_loads() {
        // Serde-additive contract: a hand-written record missing `v` (and `markedAt`)
        // loads through the defaults.
        let tmp = TempDir::new().unwrap();
        let d = dir(&tmp);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            file_path(&d),
            br#"{"marks":{"legacy":{"reasons":["claudeLaunched"]}}}"#,
        )
        .unwrap();
        assert_eq!(read_file(&d).v, SCHEMA_VERSION);
        assert!(load(&d).is_ungoverned("legacy"));
    }

    #[test]
    fn the_persisted_reason_names_are_pinned_to_their_wire_form() {
        // The on-disk form IS the wire form (camelCase). Pinned so a rename that would
        // silently orphan every existing marker fails here first.
        let json = serde_json::to_string(&TerminalGovernanceReason::ClaudeLaunched).unwrap();
        assert_eq!(json, "\"claudeLaunched\"");
        assert_eq!(
            serde_json::to_string(&TerminalGovernanceReason::TaskLinked).unwrap(),
            "\"taskLinked\""
        );
    }
}
