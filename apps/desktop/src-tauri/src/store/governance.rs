//! The per-project governance journal (issue #399) — the append-only record of
//! every governance decision a human made about THIS repo.
//!
//! WHY THIS EXISTS. The flight recorder ([`crate::store::ledger`]) answers "what
//! did this RUN do", and the Trust Report answers "what happened on this TASK".
//! Neither can answer "what has this REPO's governance looked like this month":
//! arming a check, disarming it again, quarantining a flagged file, saving a
//! policy, snapshotting the strictness ratchet — all of it landed in
//! `.nightcore/harness.json` as a silent overwrite with no history. The
//! `TrustReport.quarantine` seam was left for exactly this and had no possible
//! writer (issue #399: `project.ndjson` had zero references in the tree). This
//! module is that writer.
//!
//! ## Append-only, and what guarantees it
//! One NDJSON record per governance event at
//! `<project_root>/.nightcore/ledger/project.ndjson`, beside the per-task
//! recorder files the engine writes. Integrity rests on three properties:
//!
//!  1. **`O_APPEND` + one `write_all` per record.** The file is opened in append
//!     mode for every event, so the kernel resolves the offset and the write as
//!     one operation — a concurrent writer cannot land inside another's line, and
//!     no writer can seek backwards to rewrite history. The record is serialized
//!     to a single `String` (already newline-terminated) and written in ONE call.
//!  2. **Bounded records.** Every field is capped ([`MAX_SUMMARY_CHARS`] /
//!     [`MAX_DETAIL_ITEMS`] / [`MAX_DETAIL_CHARS`]), so a line stays far under the
//!     size where a single `write(2)` could be split — the property step 1 leans on.
//!  3. **An in-process mutex.** The desktop core is the only writer (the auto-loop,
//!     the UI thread and the blocking pool all live in it), so [`JOURNAL_LOCK`]
//!     serializes same-process appends before they ever reach the syscall — belt
//!     and braces over `O_APPEND`, and it also makes the create+`.gitignore`
//!     bootstrap race-free.
//!
//! There is deliberately NO rewrite/compact/truncate path in this module. Nothing
//! here opens the file for writing without `append(true)`.
//!
//! ## Posture
//! - **Best-effort, never fatal.** A failed append is logged at WARN and swallowed:
//!   journaling must not fail the policy save it records (the alternative — losing
//!   the user's edit because its receipt could not be written — is strictly worse).
//! - **Never secrets.** Every field goes through [`crate::infra::text::redact`] and
//!   a one-printable-line collapse before it is persisted; the caller is not
//!   trusted to have done it.
//! - **Lenient reads.** A missing file is an empty journal, and an unparseable line
//!   is SKIPPED AND COUNTED (never a panic, never a lost sibling) — the count is
//!   surfaced on the summary so corruption is visible rather than silent.
//! - **Self-protected.** The journal lives under `.nightcore/`, which the engine's
//!   policy layer implicitly denies every agent write to
//!   (`MANIFEST_PROTECTED_PATTERN` in `packages/engine/src/policy/harness-policy.ts`),
//!   and which workspace confinement keeps outside a task worktree. A governance
//!   journal an agent could rewrite would be worthless.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use crate::infra::text::redact;
use crate::infra::time::iso8601_utc;

/// The journal's file name inside the ledger dir. RESERVED: the per-task recorder
/// files are `<task_id>.ndjson` and task ids are uuids, so this name can never
/// collide — but the cross-task readers skip it explicitly rather than relying on
/// that (`crate::store::policy_activity`).
pub const JOURNAL_FILE: &str = "project.ndjson";

/// A path was quarantined — added to `policy.denyReadPaths`, which the engine's
/// PreToolUse read-denial then enforces for every future session (the action the
/// injection-surface scan card offers).
pub const KIND_QUARANTINE: &str = "quarantine";
/// The project's runtime policy block was written.
pub const KIND_POLICY_SAVE: &str = "policy-save";
/// A structure-lock check was armed (added, or re-enabled).
pub const KIND_ARM: &str = "arm";
/// A structure-lock check was disarmed (removed, or disabled).
pub const KIND_DISARM: &str = "disarm";
/// The strictness-ratchet baseline was snapshotted.
pub const KIND_RATCHET: &str = "ratchet";

/// Cap on a record's one-line summary.
const MAX_SUMMARY_CHARS: usize = 200;
/// Cap on how many detail items one record carries (e.g. quarantined paths).
const MAX_DETAIL_ITEMS: usize = 8;
/// Cap on each detail item.
const MAX_DETAIL_CHARS: usize = 160;

/// Serializes same-process appends. See the module header, property 3.
static JOURNAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The project's governance journal path. Single owner of the formula, like
/// [`crate::store::ledger::ledger_path`] is for the per-task recorder files.
pub fn journal_path(project_root: &Path) -> PathBuf {
    crate::store::ledger::ledger_dir(project_root).join(JOURNAL_FILE)
}

/// The persisted NDJSON line. Private: the wire/read model ([`GovernanceEvent`])
/// carries a synthesized `id` that is NEVER stored, so the on-disk shape stays the
/// minimum that has to survive forever. Serde-additive — every field but `ts`/
/// `kind` defaults, so a record written by an older build still loads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalLine {
    /// ISO-8601 UTC — lexicographically sortable, one writer, so string order IS
    /// chronological order.
    ts: String,
    /// One of [`KINDS`] for a record this build wrote; free-form on read.
    kind: String,
    /// The one-line, redacted, capped human summary.
    #[serde(default)]
    summary: String,
    /// Bounded supporting identifiers (quarantined paths, check names).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    detail: Vec<String>,
}

/// One journal record as a reader sees it: the persisted line plus a stable `id`.
/// The journal is append-only, so a record's line index never changes — the same
/// id formula the Policy activity feed uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "GovernanceEvent.ts"))]
pub struct GovernanceEvent {
    /// Stable React key: the record's 0-based line index in the journal.
    pub id: String,
    pub ts: String,
    /// `quarantine` | `policy-save` | `arm` | `disarm` | `ratchet` — or anything a
    /// newer build wrote (kept verbatim rather than dropped).
    pub kind: String,
    pub summary: String,
    #[serde(default)]
    pub detail: Vec<String>,
}

/// What one read of the journal learned: the parsed records (oldest first, the
/// on-disk order) and how many lines could not be parsed.
#[derive(Debug, Clone, Default)]
pub struct JournalRead {
    pub events: Vec<GovernanceEvent>,
    /// Lines that were present but unparseable. Surfaced (not swallowed) so a
    /// corrupted journal is visible on the dashboard instead of silently shrinking.
    pub corrupt_lines: u32,
}

/// Collapse untrusted text to ONE printable line, strip credential-shaped tokens,
/// and cap it. Applied to every field before it is persisted — a caller is never
/// trusted to have sanitized (the `sanitize_minted_title` posture).
fn sanitize(value: &str, max_chars: usize) -> String {
    let one_line: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let redacted = redact(one_line.trim());
    if redacted.chars().count() <= max_chars {
        return redacted;
    }
    let kept: String = redacted.chars().take(max_chars).collect();
    format!("{kept}…")
}

/// The entries `after` gained relative to `before`, in `after`'s order and deduped.
///
/// The one non-trivial phrasing input a caller needs: a policy save that ADDS
/// entries to `denyReadPaths` IS the quarantine action (the engine's PreToolUse
/// read-denial then keeps the path away from every future session — see
/// `analysis::injection_scan`), so the journal records what the save quarantined,
/// not just that a save happened. Pure, so it unit-tests without a filesystem.
pub fn added_entries(before: &[String], after: &[String]) -> Vec<String> {
    let mut added: Vec<String> = Vec::new();
    for entry in after {
        if !before.contains(entry) && !added.contains(entry) {
            added.push(entry.clone());
        }
    }
    added
}

/// Append one governance event. BEST-EFFORT: a failure is logged at WARN and
/// swallowed, so journaling can never fail the action it records.
///
/// `summary` and every `detail` item are sanitized + redacted + capped here.
pub fn append(project_root: &Path, kind: &str, summary: &str, detail: &[String]) {
    let record = JournalLine {
        ts: iso8601_utc(crate::task::now_ms()),
        kind: sanitize(kind, MAX_SUMMARY_CHARS),
        summary: sanitize(summary, MAX_SUMMARY_CHARS),
        detail: detail
            .iter()
            .take(MAX_DETAIL_ITEMS)
            .map(|d| sanitize(d, MAX_DETAIL_CHARS))
            .filter(|d| !d.is_empty())
            .collect(),
    };
    if let Err(e) = append_record(project_root, &record) {
        tracing::warn!(
            target: "nightcore::governance",
            project = %project_root.display(),
            kind = %record.kind,
            error = %e,
            "could not append to the project governance journal"
        );
    }
}

/// The fallible body of [`append`]: create the ledger dir (+ its self-ignoring
/// `.gitignore`), then append ONE newline-terminated line under the process lock.
fn append_record(project_root: &Path, record: &JournalLine) -> std::io::Result<()> {
    use std::io::Write;

    let path = journal_path(project_root);
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("journal path has no parent directory"))?;

    let mut line = serde_json::to_string(record).map_err(std::io::Error::other)?;
    line.push('\n');

    // Held across the bootstrap AND the write: two threads racing to create the
    // dir + ignore file must not interleave, and `O_APPEND` then only has to
    // defend against a hypothetical second PROCESS.
    let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)?;
    ensure_ignore_file(dir);

    let mut file = open_append(&path)?;
    // ONE write of a bounded, newline-terminated record — see the module header.
    file.write_all(line.as_bytes())?;
    file.sync_data()
}

/// Open the journal for APPEND ONLY, creating it owner-only (0600) on unix. There
/// is no other opener in this module: nothing may open the journal in a mode that
/// can seek or truncate.
fn open_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Drop a self-ignoring `.gitignore` (`*`) into the ledger dir when absent.
///
/// The journal lives INSIDE the user's repo, so without this it would show up in
/// `git status` — and, worse, make every worktree read as dirty
/// (`worktree::status` counts untracked files). Nightcore's own repo ignores
/// `.nightcore/*`, but that is this repo's convention, not something the app can
/// assume of an arbitrary project, and rewriting the user's ROOT `.gitignore` would
/// be an unasked-for edit to a tracked file. A nested ignore file scoped to the dir
/// Nightcore already owns is the narrow fix: `*` also matches the `.gitignore`
/// itself, so the guard never appears in `git status` either. Best-effort and
/// idempotent — never overwritten, and a failure just means the ledger is visible.
fn ensure_ignore_file(dir: &Path) {
    let ignore = dir.join(".gitignore");
    if ignore.exists() {
        return;
    }
    if let Err(e) = std::fs::write(&ignore, "*\n") {
        tracing::warn!(
            target: "nightcore::governance",
            path = %ignore.display(),
            error = %e,
            "could not write the ledger .gitignore; the ledger may show up in git status"
        );
    }
}

/// Read the whole journal. Missing/unreadable file ⇒ an empty read (a project that
/// has never had a governance event); an unparseable LINE is skipped and COUNTED,
/// its siblings kept.
pub fn read_journal(project_root: &Path) -> JournalRead {
    let path = journal_path(project_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return JournalRead::default();
    };

    let mut read = JournalRead::default();
    for (index, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<JournalLine>(line) {
            Ok(record) => read.events.push(GovernanceEvent {
                id: index.to_string(),
                ts: record.ts,
                kind: record.kind,
                summary: record.summary,
                detail: record.detail,
            }),
            Err(_) => read.corrupt_lines = read.corrupt_lines.saturating_add(1),
        }
    }
    read
}

#[cfg(test)]
mod tests;
