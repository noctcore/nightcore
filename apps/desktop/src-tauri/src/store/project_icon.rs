//! Per-project custom icons: persist user-supplied images under
//! `<project.path>/.nightcore/images/`, referenced from the project registry via
//! `custom_icon_path` (a repo-relative path). Lucide preset names live in
//! `Project.icon` instead — this module handles ONLY the on-disk bytes.
//!
//! Security model (mirrors [`super::board_background`] and [`super::attachments`]).
//! The client supplies project id, format token, and base64 payload; the server
//! validates format/size, resolves the project path from the registry (never from
//! the client), writes under a fixed `.nightcore/images/` subtree, and rejects any
//! stored relative path that escapes that subtree on read/delete.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::path::{Path, PathBuf};

/// Max bytes for a project icon (decoded). Smaller than board backgrounds — icons
/// are square thumbnails, but animated GIFs are allowed up to 5 MB.
pub const MAX_ICON_BYTES: usize = 5 * 1024 * 1024;

/// The allowed icon image formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconFormat {
    Png,
    Jpeg,
    Webp,
    Gif,
}

fn parse_format(format: &str) -> Result<IconFormat, String> {
    match format {
        "png" => Ok(IconFormat::Png),
        "jpeg" => Ok(IconFormat::Jpeg),
        "webp" => Ok(IconFormat::Webp),
        "gif" => Ok(IconFormat::Gif),
        other => Err(format!("unsupported image format: {other}")),
    }
}

fn ext_for(format: IconFormat) -> &'static str {
    match format {
        IconFormat::Png => "png",
        IconFormat::Jpeg => "jpeg",
        IconFormat::Webp => "webp",
        IconFormat::Gif => "gif",
    }
}

fn mime_for(format: IconFormat) -> &'static str {
    match format {
        IconFormat::Png => "image/png",
        IconFormat::Jpeg => "image/jpeg",
        IconFormat::Webp => "image/webp",
        IconFormat::Gif => "image/gif",
    }
}

/// The `.nightcore/images/` dir for a project repo (absolute).
pub fn images_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/images")
}

/// Whether a stored relative path is confined to `.nightcore/images/` (no traversal).
pub fn is_safe_icon_rel_path(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains("..")
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && rel.starts_with(".nightcore/images/")
        && rel.len() <= 256
}

/// Resolve a registry-stored relative path to an absolute file under `project_path`.
fn resolve_icon_path(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    if !is_safe_icon_rel_path(rel) {
        return Err("invalid custom icon path".to_string());
    }
    let abs = Path::new(project_path).join(rel);
    // Canonicalize parent + join filename so symlinks/`..` in stored paths can't escape.
    let canonical = abs
        .parent()
        .ok_or_else(|| "invalid custom icon path".to_string())?
        .canonicalize()
        .map_err(|e| format!("custom icon path does not resolve: {e}"))?;
    let file = canonical.join(
        abs.file_name()
            .ok_or_else(|| "invalid custom icon path".to_string())?,
    );
    let images = images_dir(project_path);
    let images_canonical = images
        .canonicalize()
        .unwrap_or(images.clone());
    if !file.starts_with(&images_canonical) {
        return Err("custom icon path escapes images dir".to_string());
    }
    Ok(file)
}

/// Sanitize a user-supplied filename base to a flat `[A-Za-z0-9_-]+` token.
fn sanitize_base(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().take(32) {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c == '.' || c.is_whitespace() {
            out.push('_');
        }
    }
    if out.is_empty() {
        "icon".to_string()
    } else {
        out
    }
}

/// Validate + persist a custom icon under `.nightcore/images/`, returning the
/// repo-relative path (`.nightcore/images/<name>.<ext>`).
pub fn persist(
    project_path: &str,
    format: &str,
    data: &str,
    original_name: Option<&str>,
) -> Result<String, String> {
    let fmt = parse_format(format)?;
    let max_encoded = MAX_ICON_BYTES.div_ceil(3) * 4 + 4;
    if data.len() > max_encoded {
        return Err(format!("image too large (max {MAX_ICON_BYTES} bytes)"));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "invalid base64 image data".to_string())?;
    if bytes.is_empty() {
        return Err("empty image".to_string());
    }
    if bytes.len() > MAX_ICON_BYTES {
        return Err(format!(
            "image too large: {} bytes (max {MAX_ICON_BYTES})",
            bytes.len()
        ));
    }

    let dir = images_dir(project_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create images dir: {e}"))?;

    let base = original_name.map(sanitize_base).unwrap_or_else(|| "icon".to_string());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let filename = format!("{base}-{ts}.{}", ext_for(fmt));
    let rel = format!(".nightcore/images/{filename}");
    let abs = dir.join(&filename);
    crate::store::write_atomic(&abs, &bytes)
        .map_err(|e| format!("cannot write icon: {e}"))?;
    Ok(rel)
}

/// Read a stored custom icon as a `data:` URL. `rel` must pass [`is_safe_icon_rel_path`].
pub fn read_data_url(project_path: &str, rel: &str) -> Result<String, String> {
    let path = resolve_icon_path(project_path, rel)?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "custom icon has no extension".to_string())?;
    let fmt = parse_format(ext)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read icon: {e}"))?;
    Ok(format!(
        "data:{};base64,{}",
        mime_for(fmt),
        STANDARD.encode(bytes)
    ))
}

/// Delete one custom icon file by its registry-relative path. Idempotent when missing.
pub fn remove_file(project_path: &str, rel: &str) -> Result<(), String> {
    let path = resolve_icon_path(project_path, rel)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove icon: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_format_accepts_the_allowed_set_only() {
        assert_eq!(parse_format("png").unwrap(), IconFormat::Png);
        assert!(parse_format("svg").is_err());
    }

    #[test]
    fn is_safe_icon_rel_path_rejects_traversal() {
        assert!(is_safe_icon_rel_path(".nightcore/images/icon.png"));
        assert!(!is_safe_icon_rel_path("../escape.png"));
        assert!(!is_safe_icon_rel_path(".nightcore/other/icon.png"));
        assert!(!is_safe_icon_rel_path("/abs/icon.png"));
    }

    #[test]
    fn persist_and_read_round_trip() {
        let tmp = TempDir::new().expect("temp dir");
        let project = tmp.path().to_string_lossy().to_string();
        // 1x1 png pixel (valid minimal png).
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let rel = persist(&project, "png", png_b64, Some("my icon.png")).expect("persist");
        assert!(rel.starts_with(".nightcore/images/"));
        let url = read_data_url(&project, &rel).expect("read");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn persist_rejects_oversize_before_write() {
        let tmp = TempDir::new().expect("temp dir");
        let project = tmp.path().to_string_lossy().to_string();
        let huge = "A".repeat(MAX_ICON_BYTES.div_ceil(3) * 4 + 8);
        assert!(persist(&project, "png", &huge, None).is_err());
    }
}
