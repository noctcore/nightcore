//! Atomic file writes + corrupt-file quarantine for the store.

/// Write `bytes` to `path` atomically: write to a sibling temp file, then `rename`
/// it over the target. A reader either sees the old file or the new one, never a
/// truncated write (data-integrity #3). The temp file is removed on a write/persist
/// failure so a crash mid-write doesn't litter the dir.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
    // A unique-ish sibling temp name (pid + nanos) so two concurrent writers to
    // different files in the same dir don't collide.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{file_name}.{}.{nonce}.tmp", std::process::id()));

    let write_then_rename = || -> std::io::Result<()> {
        let mut file = create_owner_only(&tmp)?;
        file.write_all(bytes)?;
        // `sync_data` (fdatasync), not `sync_all` (fsync): durability here only needs
        // the file's *contents* + the metadata required to read them back (size/block
        // map) on disk before the rename. The non-essential inode metadata `sync_all`
        // also flushes (mtime/atime) is pure overhead on this hot per-mutation path —
        // a status bump or `updated_at` tick fsyncs the whole record otherwise. The
        // atomic rename still gives a reader the old-or-new file, never a torn write.
        file.sync_data()?;
        drop(file);
        std::fs::rename(&tmp, path)
    };
    let result = write_then_rename();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Create+truncate a fresh file for writing with owner-only (0600) permissions
/// applied AT CREATION on Unix, so a secret-bearing atomic write (e.g. settings.json
/// with plaintext MCP env/headers) never exists at the default umask (0644) — not
/// even for the temp-file window before the caller's late `restrict_to_owner`, and
/// not permanently if a crash lands between the rename and that chmod. On non-Unix
/// there is no mode bit; a plain create is used.
fn create_owner_only(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::File::create(path)
    }
}

/// Move an unparsable store file aside to a non-clobbering `<name>.corrupt-<millis>`
/// sibling, returning the backup path. Single-file stores (settings.json,
/// projects.json) load all-or-nothing: on a parse error the caller falls back to
/// defaults, and the NEXT write would persist those defaults over the bad file —
/// permanently erasing recoverable data (incl. plaintext MCP secrets). Quarantining
/// first means the later overwrite lands on a now-absent path instead. Best-effort:
/// the rename can fail (e.g. read-only dir); callers log and continue.
pub(crate) fn quarantine_corrupt(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "store.json".to_string());
    let backup = path.with_file_name(format!("{name}.corrupt-{millis}"));
    std::fs::rename(path, &backup)?;
    Ok(backup)
}
