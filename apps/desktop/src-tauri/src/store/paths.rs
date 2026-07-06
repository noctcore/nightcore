//! Path safety + workspace-root resolution for the store.

use std::path::PathBuf;

/// Whether a task id is a safe filename component (defence in depth against path
/// traversal at the `<id>.json` join). Ids are server-minted uuids, but the id
/// also arrives from the wire on commands; an id carrying `.` / `/` / `\` (or any
/// path separator) could escape the tasks dir, so reject anything that isn't a
/// flat `[A-Za-z0-9_-]+` token. Empty is rejected too. Shared with `transcript.rs`.
pub(crate) fn is_safe_task_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Workspace root (`apps/desktop/src-tauri` → up three), the same cwd resolution
/// M0 used for the sidecar. M1 keeps tasks under this project's `.nightcore/`.
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
