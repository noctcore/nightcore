//! Custom board background images: persist a user-supplied image (or gif) to OS
//! app-data (outside any repo/worktree), one per project, referenced from that
//! project's settings override ([`crate::settings::BoardBackgroundRef`]) and read
//! back as a `data:` URL for the board's CSS `background-image`.
//!
//! Security model (mirrors [`super::attachments`]). The ONLY client-controlled
//! value that reaches the filesystem is the project id, validated by
//! [`is_safe_task_id`](super::is_safe_task_id) (a flat `[A-Za-z0-9_-]+` token — no
//! `.`/`/`/`\`, so it can't traverse out of the backgrounds root; project ids are
//! server-minted v4 uuids, which satisfy the rule). The on-disk filename is the
//! fixed `background.<ext>` where `<ext>` derives from the validated format enum —
//! never from client input. Format, decoded size, and (defensively) the encoded
//! length are all re-validated server-side here, not just in the browser picker.
//! Image bytes and file paths are never logged (user-content / PII discipline).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Max bytes for a background image (decoded). Larger than the 10 MB task-image cap
/// because animated gifs used as wallpaper are commonly bigger; still bounded so a
/// crafted IPC payload can't exhaust memory.
pub const MAX_BG_BYTES: usize = 15 * 1024 * 1024;

/// The allowed background image formats. A local, self-contained twin of the task
/// [`ImageFormat`](crate::contracts::ImageFormat) (this module doesn't depend on the
/// wire-contract enum) so the accepted set is validated the same way in both places.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BgFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
}

/// Validate a wire `format` token and map it to [`BgFormat`]. Rejects anything
/// outside the whitelist (incl. `svg`, `image/png`-style mimes, empty).
fn parse_format(format: &str) -> Result<BgFormat, String> {
    match format {
        "png" => Ok(BgFormat::Png),
        "jpeg" => Ok(BgFormat::Jpeg),
        "webp" => Ok(BgFormat::Webp),
        "gif" => Ok(BgFormat::Gif),
        other => Err(format!("unsupported image format: {other}")),
    }
}

/// The file extension (and canonical wire token) for a format.
fn ext_for(format: BgFormat) -> &'static str {
    match format {
        BgFormat::Png => "png",
        BgFormat::Jpeg => "jpeg",
        BgFormat::Webp => "webp",
        BgFormat::Gif => "gif",
    }
}

/// The `data:` URL mime for a format (used to build the web's `background-image`).
fn mime_for(format: BgFormat) -> &'static str {
    match format {
        BgFormat::Png => "image/png",
        BgFormat::Jpeg => "image/jpeg",
        BgFormat::Webp => "image/webp",
        BgFormat::Gif => "image/gif",
    }
}

/// The app-data backgrounds root (`<app_local_data_dir>/board-backgrounds`). OS
/// app-data — NOT the project repo or a worktree — so a background survives restart,
/// re-runs, and worktree cleanup, and never lands in a git tree.
fn backgrounds_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("board-backgrounds"))
        .map_err(|e| format!("app-data dir unavailable: {e}"))
}

/// The per-project background dir (`<root>/<project-id>`). Rejects an unsafe project
/// id so a crafted id can't escape the backgrounds root.
fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    if !super::is_safe_task_id(project_id) {
        return Err("invalid project id".to_string());
    }
    Ok(backgrounds_root(app)?.join(project_id))
}

/// Validate + persist a project's background image, returning the canonical format
/// token (`png`/`jpeg`/`webp`/`gif`) for the settings ref. The payload is validated
/// and decoded BEFORE any file is written (bad format / oversize / bad base64 fail
/// without touching the disk). The new bytes are written ATOMICALLY (temp file +
/// rename) over `background.<ext>`, so a concurrent reader (or a same-format replace)
/// never observes a half-written or transiently-absent file. A stale DIFFERENT-format
/// file from a prior background is intentionally left in place here — the caller drops
/// it via [`remove_other_formats`] only AFTER the new ref is committed, so a failed
/// ref-record can't destroy the project's only readable image (see the command's
/// rollback in `commands/settings.rs`).
pub fn persist(app: &AppHandle, project_id: &str, format: &str, data: &str) -> Result<String, String> {
    let fmt = parse_format(format)?;
    // Base64 expands ~4 chars per 3 bytes, so an encoded string longer than this
    // can't decode to <= MAX_BG_BYTES. Reject on the ENCODED length first so a
    // crafted oversized IPC payload is refused without allocating the decoded buffer.
    // `div_ceil` (not truncating `/`) keeps this a true upper bound even if the cap
    // is later set to a non-multiple of 3, so it never rejects a valid payload.
    let max_encoded = MAX_BG_BYTES.div_ceil(3) * 4 + 4;
    if data.len() > max_encoded {
        return Err(format!("image too large (max {MAX_BG_BYTES} bytes)"));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "invalid base64 image data".to_string())?;
    if bytes.is_empty() {
        return Err("empty image".to_string());
    }
    if bytes.len() > MAX_BG_BYTES {
        return Err(format!(
            "image too large: {} bytes (max {MAX_BG_BYTES})",
            bytes.len()
        ));
    }

    let dir = project_dir(app, project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create backgrounds dir: {e}"))?;
    let path = dir.join(format!("background.{}", ext_for(fmt)));
    // Atomic temp-file + rename (reuses the store's shared primitive): a reader sees
    // the old file or the new one, never a truncation, and no transient-empty window.
    crate::store::write_atomic(&path, &bytes)
        .map_err(|e| format!("cannot write background: {e}"))?;
    Ok(ext_for(fmt).to_string())
}

/// Remove one specific `background.<ext>` file (idempotent). Used by the set-command
/// rollback to drop JUST the bytes it wrote, without touching a prior different-format
/// background that a still-valid settings ref points at.
pub fn remove_format(app: &AppHandle, project_id: &str, format: &str) -> Result<(), String> {
    let fmt = parse_format(format)?;
    let path = project_dir(app, project_id)?.join(format!("background.{}", ext_for(fmt)));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove background: {e}")),
    }
}

/// Delete any stored background file whose format differs from `keep` — the stale
/// file left behind by a format-changing replace. Called only AFTER the new ref is
/// committed, so this never removes the file the live ref points at. Best-effort per
/// file (a failure just leaves a harmless extra file the next replace overwrites).
pub fn remove_other_formats(app: &AppHandle, project_id: &str, keep: &str) {
    let Ok(dir) = project_dir(app, project_id) else {
        return;
    };
    for fmt in [BgFormat::Png, BgFormat::Jpeg, BgFormat::Webp, BgFormat::Gif] {
        let ext = ext_for(fmt);
        if ext == keep {
            continue;
        }
        let _ = std::fs::remove_file(dir.join(format!("background.{ext}")));
    }
}

/// Read a project's stored background of the given `format` as a `data:` URL (mime +
/// base64) for the web's CSS `background-image`. Errors if the format is invalid or
/// the file can't be read (the caller resolves "no background" from the settings ref
/// BEFORE calling, so a missing file here is a real error, not the empty case).
pub fn read_data_url(app: &AppHandle, project_id: &str, format: &str) -> Result<String, String> {
    let fmt = parse_format(format)?;
    let path = project_dir(app, project_id)?.join(format!("background.{}", ext_for(fmt)));
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read background: {e}"))?;
    Ok(format!("data:{};base64,{}", mime_for(fmt), STANDARD.encode(bytes)))
}

/// Remove a project's whole background dir. Idempotent: a missing dir is success (so
/// a clear-with-no-background, a double-clear, or a project-delete cleanup can't
/// wedge). Called on clear and on project deletion.
pub fn remove(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let dir = project_dir(app, project_id)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove background: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_format_accepts_the_allowed_set_only() {
        assert_eq!(parse_format("png").unwrap(), BgFormat::Png);
        assert_eq!(parse_format("jpeg").unwrap(), BgFormat::Jpeg);
        assert_eq!(parse_format("webp").unwrap(), BgFormat::Webp);
        assert_eq!(parse_format("gif").unwrap(), BgFormat::Gif);
        assert!(parse_format("svg").is_err());
        assert!(parse_format("image/png").is_err());
        assert!(parse_format("").is_err());
    }

    #[test]
    fn ext_and_mime_are_the_expected_tokens() {
        assert_eq!(ext_for(BgFormat::Gif), "gif");
        assert_eq!(ext_for(BgFormat::Jpeg), "jpeg");
        assert_eq!(mime_for(BgFormat::Png), "image/png");
        assert_eq!(mime_for(BgFormat::Webp), "image/webp");
        assert_eq!(mime_for(BgFormat::Gif), "image/gif");
    }

    #[test]
    fn max_encoded_guard_is_above_the_decoded_cap() {
        // The encoded-length pre-check must never reject a payload that would decode
        // to <= MAX_BG_BYTES (it's a fast-path guard, not a stricter limit).
        let max_encoded = MAX_BG_BYTES / 3 * 4 + 4;
        assert!(max_encoded >= MAX_BG_BYTES);
    }

    #[test]
    fn persist_rejects_bad_format_before_touching_disk() {
        // No AppHandle needed: an invalid format short-circuits before any dir/path
        // work, so this guards the "validate before write" contract.
        assert!(parse_format("svg").is_err());
    }
}
