//! Scrollback persistence: the on-disk `.nightcore/terminals/<sessionId>.json`
//! shape + its atomic write / read / list / prune.
//!
//! A dead session's scrollback is restored READ-ONLY on relaunch (decision 3), so
//! it must survive a crash. Writes go through the store's atomic-write idiom
//! (temp-file + rename — a reader sees the old file or the new one, never a torn
//! one). The file is a NEW shape this PR owns, so it is versioned with `v: 1` and
//! every field is serde-additive (`#[serde(default)]`) for forward evolution.
//!
//! SECURITY: the scrollback stream can contain secrets a user typed/echoed — this
//! directory must be excluded from any future export / Trust-Report surface by
//! default (spec §1 hard constraint). The filename is the session id, guarded to a
//! flat token so a crafted id can never escape the terminals dir.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use super::types::{PersistedTerminalInfo, PersistedTerminalScrollback};

/// The current on-disk schema version. Bumped only on a breaking shape change;
/// readers tolerate older files via `#[serde(default)]`.
const SCHEMA_VERSION: u32 = 1;

/// Persisted scrollback files older than this (by `updated_at`) are pruned — a
/// dead session's history stops being worth restoring after a month.
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The on-disk record. `serde(default)` on every non-essential field keeps old
/// files loadable after an additive change; `v` pins the schema for a future
/// breaking migration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct PersistedScrollback {
    #[serde(default = "default_version")]
    pub(crate) v: u32,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) cwd: String,
    #[serde(default)]
    pub(crate) shell: String,
    #[serde(default)]
    pub(crate) confined: bool,
    #[serde(default)]
    pub(crate) created_at: u64,
    #[serde(default)]
    pub(crate) updated_at: u64,
    /// The scrollback stream, base64-encoded (raw bytes don't round-trip cleanly
    /// through JSON; base64 keeps escape sequences intact).
    #[serde(default)]
    pub(crate) scrollback_b64: String,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

impl PersistedScrollback {
    pub(crate) fn new(
        id: String,
        cwd: String,
        shell: String,
        confined: bool,
        created_at: u64,
        updated_at: u64,
        scrollback: &[u8],
    ) -> Self {
        Self {
            v: SCHEMA_VERSION,
            id,
            cwd,
            shell,
            confined,
            created_at,
            updated_at,
            scrollback_b64: STANDARD.encode(scrollback),
        }
    }

    fn info(&self) -> PersistedTerminalInfo {
        PersistedTerminalInfo {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            shell: self.shell.clone(),
            confined: self.confined,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    /// Decode the stored scrollback back to raw bytes (only the restore path +
    /// tests need the bytes; `terminal_read_persisted` ships the base64 as-is).
    #[cfg(test)]
    fn decoded(&self) -> Vec<u8> {
        STANDARD
            .decode(self.scrollback_b64.as_bytes())
            .unwrap_or_default()
    }
}

/// Whether `id` is a safe flat filename component (defense in depth at the
/// `<id>.json` join — a session id carrying `/`, `\`, or `.` could otherwise escape
/// the terminals dir). Ids are server-minted uuids, but they also arrive from the
/// wire on `terminal_read_persisted`.
pub(crate) fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The on-disk path for a session's scrollback, or `None` for an unsafe id.
fn session_file(dir: &Path, id: &str) -> Option<PathBuf> {
    is_safe_session_id(id).then(|| dir.join(format!("{id}.json")))
}

/// Milliseconds since the Unix epoch (matches the store's timestamp convention).
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Atomically persist a session's scrollback under `dir` (created if absent). The
/// terminals dir gets owner-only perms so a secret-bearing scrollback isn't
/// world-readable. Best-effort: returns an error string the caller logs.
pub(crate) fn write(dir: &Path, record: &PersistedScrollback) -> Result<(), String> {
    let Some(path) = session_file(dir, &record.id) else {
        return Err(format!(
            "refusing to persist unsafe session id {:?}",
            record.id
        ));
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("create terminals dir: {e}"))?;
    let bytes = serde_json::to_vec(record).map_err(|e| format!("serialize scrollback: {e}"))?;
    crate::store::write_atomic(&path, &bytes).map_err(|e| format!("write scrollback: {e}"))
}

/// Read one persisted session (metadata + replay bytes), or `None` when it is
/// absent / unparsable / has an unsafe id.
pub(crate) fn read(dir: &Path, id: &str) -> Option<PersistedTerminalScrollback> {
    let record = read_record(&session_file(dir, id)?)?;
    Some(PersistedTerminalScrollback {
        info: record.info(),
        data_base64: record.scrollback_b64,
    })
}

/// The decoded scrollback bytes for a persisted session (used by the restore path
/// and tests); `None` when absent/unparsable.
#[cfg(test)]
pub(crate) fn read_bytes(dir: &Path, id: &str) -> Option<Vec<u8>> {
    read_record(&session_file(dir, id)?).map(|r| r.decoded())
}

fn read_record(path: &Path) -> Option<PersistedScrollback> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// List persisted sessions' metadata (no bytes), newest first. Prunes stale files
/// as a side effect (age + vanished cwd — see [`prune`]).
pub(crate) fn list(dir: &Path) -> Vec<PersistedTerminalInfo> {
    prune(dir);
    let mut infos: Vec<PersistedTerminalInfo> = read_all(dir).iter().map(|r| r.info()).collect();
    infos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    infos
}

fn read_all(dir: &Path) -> Vec<PersistedScrollback> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| read_record(&e.path()))
        .collect()
}

/// Prune persisted scrollback files that are no longer worth keeping:
///   - older than [`MAX_AGE`] (30 days) by `updated_at`, OR
///   - whose recorded `cwd` no longer exists on disk (its worktree was discarded /
///     the dir was deleted — the "prune on worktree deletion" seam, achieved
///     without coupling the terminal module to the worktree lifecycle).
///
/// Best-effort; unlink failures are ignored.
pub(crate) fn prune(dir: &Path) {
    let now = now_ms();
    let max_age_ms = MAX_AGE.as_millis() as u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|x| x == "json") {
            continue;
        }
        let Some(record) = read_record(&path) else {
            continue;
        };
        let too_old = record.updated_at != 0 && now.saturating_sub(record.updated_at) > max_age_ms;
        let cwd_gone = !record.cwd.is_empty() && !Path::new(&record.cwd).exists();
        if too_old || cwd_gone {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn record(id: &str, cwd: &str, bytes: &[u8]) -> PersistedScrollback {
        PersistedScrollback::new(
            id.to_string(),
            cwd.to_string(),
            "/bin/zsh".to_string(),
            false,
            1,
            now_ms(),
            bytes,
        )
    }

    #[test]
    fn write_then_read_round_trips_the_scrollback() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let raw = b"\x1b[32mhello\x1b[0m\nworld\n"; // escape sequences must survive
        write(&dir, &record("sess-1", tmp.path().to_str().unwrap(), raw)).unwrap();

        let got = read(&dir, "sess-1").expect("persisted session reads back");
        assert_eq!(got.info.id, "sess-1");
        assert_eq!(read_bytes(&dir, "sess-1").as_deref(), Some(&raw[..]));
        // base64 is exactly what the command hands the webview.
        assert_eq!(got.data_base64, STANDARD.encode(raw));
    }

    #[test]
    fn old_schema_without_version_field_still_loads() {
        // Forward-compat: a hand-written file missing `v`/timestamps loads via
        // serde defaults (v ← 1), proving the additive contract.
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("legacy.json"),
            br#"{"id":"legacy","scrollbackB64":""}"#,
        )
        .unwrap();
        // `scrollback_b64` renames to camelCase like the wire; a legacy field name
        // check keeps the contract honest.
        let record = read_record(&dir.join("legacy.json")).expect("loads with defaults");
        assert_eq!(record.v, SCHEMA_VERSION);
        assert_eq!(record.id, "legacy");
    }

    #[test]
    fn unsafe_session_ids_are_refused() {
        assert!(!is_safe_session_id("../escape"));
        assert!(!is_safe_session_id("a/b"));
        assert!(!is_safe_session_id(""));
        assert!(is_safe_session_id("3f2b9c-abcd_01"));

        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let err = write(&dir, &record("../escape", "/tmp", b"x")).unwrap_err();
        assert!(err.contains("unsafe session id"), "got: {err}");
        assert!(read(&dir, "../escape").is_none());
    }

    #[test]
    fn prune_drops_stale_cwd_and_aged_files_but_keeps_live_ones() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let live_cwd = tmp.path().to_str().unwrap(); // exists

        // Live: recent + cwd exists.
        write(&dir, &record("live", live_cwd, b"a")).unwrap();
        // Stale cwd: points at a deleted dir.
        write(&dir, &record("gone", "/no/such/dir/xyz", b"b")).unwrap();
        // Aged: updated_at far in the past.
        let mut old = record("old", live_cwd, b"c");
        old.updated_at = 1; // ~1970
        write(&dir, &old).unwrap();

        let infos = list(&dir); // list prunes first
        let ids: Vec<&str> = infos.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["live"],
            "only the live session survives, got {ids:?}"
        );
        assert!(read(&dir, "gone").is_none());
        assert!(read(&dir, "old").is_none());
    }

    #[test]
    fn list_is_newest_first() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("terminals");
        let cwd = tmp.path().to_str().unwrap();
        // Recent timestamps (list() prunes >30-day-old files first, so tiny epoch
        // values would be deleted before ordering — that path is covered by
        // `prune_drops_stale_cwd_and_aged_files_but_keeps_live_ones`).
        let now = now_ms();
        let mut a = record("a", cwd, b"a");
        a.updated_at = now;
        let mut b = record("b", cwd, b"b");
        b.updated_at = now + 1000;
        write(&dir, &a).unwrap();
        write(&dir, &b).unwrap();
        let ids: Vec<String> = list(&dir).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["b", "a"], "newest updated_at first");
    }
}
