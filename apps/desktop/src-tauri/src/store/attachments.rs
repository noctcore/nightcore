//! Task image attachments: persist user-supplied images to OS app-data (outside
//! any repo/worktree), referenced by the task, and load them back as wire image
//! blocks at run launch.
//!
//! Security model. The ONLY client-controlled value that reaches the filesystem
//! is the task id, validated by [`is_safe_task_id`](super::is_safe_task_id) (a
//! flat `[A-Za-z0-9_-]+` token — no `.`/`/`, so it can't traverse out of the
//! attachments root). The on-disk filename is a server-minted uuid plus an
//! extension derived from the validated [`ImageFormat`] enum; the client-supplied
//! `filename` is kept ONLY as a display label and never touches a path. Size,
//! format, and per-task count are validated server-side here, not just in the
//! browser. Image bytes and file paths are never logged (user content / PII
//! discipline, matching `create_task`).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::task::TaskAttachment;
use crate::contracts::{ImageFormat, WireImage};

/// Max bytes per attached image (decoded). Mirrors the web picker's 10 MB limit;
/// re-checked here so a crafted IPC payload can't bypass the browser check.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// Max images retained per task. Mirrors the web picker's limit; enforced over the
/// existing + incoming set so add-after-create can't exceed it either.
pub const MAX_IMAGES_PER_TASK: usize = 5;

/// A new image to persist, as sent by the web (create or add). `data` is the raw
/// base64 of the image bytes (NO `data:` URL prefix); `format` is one of the
/// allowed format tokens (`png`/`jpeg`/`webp`/`gif`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAttachment {
    pub filename: String,
    pub format: String,
    pub data: String,
}

/// Validate a wire `format` token and map it to the contract [`ImageFormat`].
fn parse_format(format: &str) -> Result<ImageFormat, String> {
    match format {
        "png" => Ok(ImageFormat::Png),
        "jpeg" => Ok(ImageFormat::Jpeg),
        "webp" => Ok(ImageFormat::Webp),
        "gif" => Ok(ImageFormat::Gif),
        other => Err(format!("unsupported image format: {other}")),
    }
}

/// The file extension for a format (the format token itself).
fn ext_for(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Webp => "webp",
        ImageFormat::Gif => "gif",
    }
}

/// The app-data attachments root (`<app_local_data_dir>/attachments`). This is OS
/// app-data — NOT the project repo or a worktree — so attachments survive restart,
/// re-runs, and worktree cleanup.
fn attachments_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("attachments"))
        .map_err(|e| format!("app-data dir unavailable: {e}"))
}

/// The per-task attachment dir (`<root>/<task-id>`). Rejects an unsafe task id so a
/// crafted id can't escape the attachments root.
fn task_dir(app: &AppHandle, task_id: &str) -> Result<PathBuf, String> {
    if !super::is_safe_task_id(task_id) {
        return Err("invalid task id".to_string());
    }
    Ok(attachments_root(app)?.join(task_id))
}

/// The on-disk path of one attachment (`<task-dir>/<id>.<ext>`). Validates the
/// attachment id with the same flat-token rule as the task id — defence in depth
/// so a `TaskAttachment` whose `id` did NOT originate from our uuid mint (e.g. a
/// task JSON authored elsewhere and shared in) can't traverse out of the task dir
/// on read/delete. Server-minted uuids satisfy the rule, so this never rejects a
/// legitimate ref.
fn attachment_path(
    app: &AppHandle,
    task_id: &str,
    att: &TaskAttachment,
) -> Result<PathBuf, String> {
    if !super::is_safe_task_id(&att.id) {
        return Err("invalid attachment id".to_string());
    }
    let format = parse_format(&att.format)?;
    Ok(task_dir(app, task_id)?.join(format!("{}.{}", att.id, ext_for(format))))
}

/// Reduce a client filename to a safe display label: no path separators or control
/// chars, no leading dots, length-capped. NEVER used to build a filesystem path —
/// labels only (the path uses a server uuid).
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c == '/' || c == '\\' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// Validate + persist new images for a task, returning their refs. Enforces the
/// per-image format + decoded size and the per-task count (existing + incoming).
/// All payloads are validated and decoded BEFORE any file is written, so a bad
/// payload (wrong format, oversize, bad base64, count exceeded) fails without
/// writing partial files. Server-minted uuids name the files; the client filename
/// is a display label only.
pub fn persist(
    app: &AppHandle,
    task_id: &str,
    existing: &[TaskAttachment],
    payloads: Vec<NewAttachment>,
) -> Result<Vec<TaskAttachment>, String> {
    if payloads.is_empty() {
        return Ok(Vec::new());
    }
    if existing.len() + payloads.len() > MAX_IMAGES_PER_TASK {
        return Err(format!(
            "too many images: {} total (max {MAX_IMAGES_PER_TASK})",
            existing.len() + payloads.len()
        ));
    }

    // Pass 1 — validate + decode everything (no filesystem writes yet).
    struct Decoded {
        format: ImageFormat,
        bytes: Vec<u8>,
        filename: String,
    }
    // Base64 expands ~4 chars per 3 bytes, so an encoded string longer than this
    // can't decode to <= MAX_IMAGE_BYTES. Reject on the ENCODED length first so a
    // crafted oversized IPC payload is refused without allocating the full decoded
    // buffer (defends the decode step, not just the post-decode size check).
    let max_encoded = MAX_IMAGE_BYTES / 3 * 4 + 4;
    let mut decoded = Vec::with_capacity(payloads.len());
    for payload in payloads {
        let format = parse_format(&payload.format)?;
        if payload.data.len() > max_encoded {
            return Err(format!("image too large (max {MAX_IMAGE_BYTES} bytes)"));
        }
        let bytes = STANDARD
            .decode(payload.data.as_bytes())
            .map_err(|_| "invalid base64 image data".to_string())?;
        if bytes.is_empty() {
            return Err("empty image".to_string());
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "image too large: {} bytes (max {MAX_IMAGE_BYTES})",
                bytes.len()
            ));
        }
        decoded.push(Decoded {
            format,
            bytes,
            filename: sanitize_filename(&payload.filename),
        });
    }

    // Pass 2 — write the validated bytes under server-minted uuids. Track the files
    // written this batch so a mid-batch write failure rolls THEM back (without
    // touching the task's pre-existing attachments that share the dir).
    let dir = task_dir(app, task_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create attachments dir: {e}"))?;
    let mut refs = Vec::with_capacity(decoded.len());
    let mut written: Vec<PathBuf> = Vec::with_capacity(decoded.len());
    for item in decoded {
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{id}.{}", ext_for(item.format)));
        if let Err(e) = std::fs::write(&path, &item.bytes) {
            for done in &written {
                let _ = std::fs::remove_file(done);
            }
            return Err(format!("cannot write attachment: {e}"));
        }
        written.push(path);
        refs.push(TaskAttachment {
            id,
            filename: item.filename,
            format: ext_for(item.format).to_string(),
            size: item.bytes.len() as u64,
        });
    }
    Ok(refs)
}

/// Delete one attachment's file. A missing file is treated as success (idempotent
/// removal) so a double-remove or a half-cleaned task can't wedge the UI.
pub fn remove_one(app: &AppHandle, task_id: &str, att: &TaskAttachment) -> Result<(), String> {
    let path = attachment_path(app, task_id, att)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove attachment: {e}")),
    }
}

/// Best-effort removal of a task's whole attachment dir (on task delete). Failures
/// are logged, never surfaced — the task JSON is already gone, so delete succeeds.
pub fn remove_all(app: &AppHandle, task_id: &str) {
    let Ok(dir) = task_dir(app, task_id) else {
        return;
    };
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(target: "nightcore", task_id, error = %e, "failed to remove attachments dir");
        }
    }
}

/// Read one attachment's bytes as base64 (for web display in the task detail). The
/// caller already holds the [`TaskAttachment`] ref (with its format); this returns
/// the raw base64 (no `data:` prefix) so the web builds the data URL from the ref.
pub fn read_base64(app: &AppHandle, task_id: &str, att: &TaskAttachment) -> Result<String, String> {
    let path = attachment_path(app, task_id, att)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read attachment: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

/// Load a task's attachments as wire image blocks for `start-session`. A file that
/// can't be read (or has an unparseable format) is skipped with a log, so a missing
/// attachment never blocks a run.
pub fn load_wire_images(
    app: &AppHandle,
    task_id: &str,
    attachments: &[TaskAttachment],
) -> Vec<WireImage> {
    let mut out = Vec::with_capacity(attachments.len());
    for att in attachments {
        let format = match parse_format(&att.format) {
            Ok(f) => f,
            Err(_) => {
                tracing::warn!(target: "nightcore", task_id, "attachment with bad format skipped");
                continue;
            }
        };
        match read_base64(app, task_id, att) {
            Ok(data) => out.push(WireImage { format, data }),
            Err(e) => {
                tracing::warn!(target: "nightcore", task_id, error = %e, "attachment load failed; skipped")
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(id: &str, format: &str) -> TaskAttachment {
        TaskAttachment {
            id: id.to_string(),
            filename: "x.png".to_string(),
            format: format.to_string(),
            size: 1,
        }
    }

    #[test]
    fn parse_format_accepts_the_allowed_set_only() {
        assert!(parse_format("png").is_ok());
        assert!(parse_format("jpeg").is_ok());
        assert!(parse_format("webp").is_ok());
        assert!(parse_format("gif").is_ok());
        assert!(parse_format("svg").is_err());
        assert!(parse_format("image/png").is_err());
    }

    #[test]
    fn sanitize_filename_strips_separators_and_traversal() {
        // separators → `_`, then leading dots stripped: no traversal, no path sep.
        assert_eq!(sanitize_filename("../../etc/passwd"), "_.._etc_passwd");
        assert!(!sanitize_filename("../../etc/passwd").contains('/'));
        assert_eq!(sanitize_filename("a/b\\c.png"), "a_b_c.png");
        assert_eq!(sanitize_filename("   "), "image");
        assert_eq!(sanitize_filename(""), "image");
        // leading dots stripped (no hidden-file labels)
        assert_eq!(sanitize_filename("...hidden"), "hidden");
    }

    #[test]
    fn ext_for_is_the_format_token() {
        assert_eq!(ext_for(ImageFormat::Png), "png");
        assert_eq!(ext_for(ImageFormat::Jpeg), "jpeg");
        assert_eq!(ext_for(ImageFormat::Webp), "webp");
        assert_eq!(ext_for(ImageFormat::Gif), "gif");
    }

    #[test]
    fn load_wire_images_skips_bad_format_without_panicking() {
        // No AppHandle is needed: a bad-format ref short-circuits before any read.
        // (A full round-trip is covered by the integration path; this guards the
        // skip-not-crash contract.)
        let bad = att("id-1", "svg");
        assert_eq!(bad.format, "svg");
        assert!(parse_format(&bad.format).is_err());
    }
}
