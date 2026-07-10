//! Editor detection (CLI-first) + the reveal-in-file-manager / open-in-editor
//! launchers behind the worktree "Reveal" and "Open in editor" conveniences.
//!
//! Both launchers take a path the *command layer* has already resolved from the
//! store and confined to the worktrees base (never a raw path from the webview —
//! the same server-side-only posture as `open_external`). This module only
//! decides WHICH program to run and hands it an argv path (never a shell string),
//! reaping the short-lived child on a detached thread like `pr::open`.
//!
//! **Editor allowlist as a security boundary.** The persisted `preferred_editor`
//! is user-controlled JSON. [`resolve_editor`] only ever returns a command from
//! [`KNOWN_EDITORS`], so a poisoned `settings.json` can never make this seam spawn
//! an arbitrary program — an unrecognized stored value is ignored and detection
//! falls through to the installed known editors.

use std::path::Path;

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

/// Known CLI editors in detection-priority order: `(command, human label)`. The
/// command doubles as the id persisted in Settings, so a stored editor is always
/// one of these allowlisted launch commands (resolved on PATH via `which`), never
/// an arbitrary program. Ordered Cursor → VS Code → … so the auto-detect fallback
/// prefers the AI-native editors this studio's users most likely run.
pub(crate) const KNOWN_EDITORS: &[(&str, &str)] = &[
    ("cursor", "Cursor"),
    ("code", "VS Code"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("webstorm", "WebStorm"),
    ("idea", "IntelliJ IDEA"),
    ("nvim", "Neovim"),
    ("vim", "Vim"),
    ("hx", "Helix"),
    ("emacs", "Emacs"),
];

/// One editor detected on this machine — a [`KNOWN_EDITORS`] entry whose command
/// resolves on PATH. Drives the Settings "Open in editor" picker. Serializes
/// camelCase for the bridge; ts-rs exports the twin under test (like every other
/// command-return shape).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DetectedEditor.ts"))]
pub struct DetectedEditor {
    /// The launch command / persisted id (`code`, `cursor`, …).
    pub id: String,
    /// The human label for the picker option.
    pub label: String,
}

/// Whether `id` is one of the allowlisted [`KNOWN_EDITORS`] commands.
fn is_known(id: &str) -> bool {
    KNOWN_EDITORS.iter().any(|(cmd, _)| *cmd == id)
}

/// The human label for a known editor command, or the command itself as a
/// fallback (used only when the label lookup can't fail in practice).
fn label_for(id: &str) -> &str {
    KNOWN_EDITORS
        .iter()
        .find(|(cmd, _)| *cmd == id)
        .map(|(_, label)| *label)
        .unwrap_or(id)
}

/// The known editors actually installed on this machine, in priority order —
/// each [`KNOWN_EDITORS`] command that resolves on PATH via `which`. Pure
/// filesystem probing; no spawning. Empty when none are installed (the caller
/// tells the user to install one or use Finder).
pub fn detect_editors() -> Vec<DetectedEditor> {
    KNOWN_EDITORS
        .iter()
        .filter(|(cmd, _)| which::which(cmd).is_ok())
        .map(|(cmd, label)| DetectedEditor {
            id: (*cmd).to_string(),
            label: (*label).to_string(),
        })
        .collect()
}

/// Decide which editor command to launch:
/// - a `preferred` that is a KNOWN + installed editor wins;
/// - a `preferred` that is KNOWN but NOT installed surfaces a precise error
///   (so the toast names the missing editor rather than silently launching a
///   different one);
/// - a `preferred` that is unrecognized (a stale/garbage stored value) is
///   IGNORED — detection falls through to the first installed known editor;
/// - with no usable preference, the first installed [`KNOWN_EDITORS`] entry;
/// - none installed ⇒ an actionable error.
///
/// The returned string is always a [`KNOWN_EDITORS`] command (the allowlist that
/// keeps a poisoned settings value from spawning an arbitrary program).
pub fn resolve_editor(preferred: Option<&str>) -> Result<String, String> {
    if let Some(pref) = preferred.map(str::trim).filter(|p| !p.is_empty()) {
        if is_known(pref) {
            // A recognized pick: honor it iff installed, else say which one is missing.
            return which::which(pref).map(|_| pref.to_string()).map_err(|_| {
                format!(
                    "{} is not installed or not on PATH — pick another editor in Settings or open the folder from Finder",
                    label_for(pref)
                )
            });
        }
        // Unrecognized stored value (not on the allowlist): ignore it and auto-detect,
        // rather than trusting an arbitrary command from settings.json.
    }
    detect_editors().into_iter().next().map(|e| e.id).ok_or_else(|| {
        "no supported editor found on PATH — install one (Cursor, VS Code, Zed, …) or open the folder from Finder".to_string()
    })
}

/// Launch `editor` (a [`KNOWN_EDITORS`] command, already resolved by
/// [`resolve_editor`]) on `path`, passed as a single argv — never a shell string,
/// so a worktree path with spaces/metacharacters is inert. Routes through the
/// platform resolver (PATHEXT-aware on Windows) and reaps the child on a detached
/// thread (editors fork-and-exit, or stay foreground as their own process — we
/// never block on them).
pub fn open_in_editor_at(editor: &str, path: &Path) -> Result<(), String> {
    // Defense in depth: only ever spawn an allowlisted command, even though every
    // caller comes through `resolve_editor`.
    if !is_known(editor) {
        return Err(format!("refusing to launch an unknown editor `{editor}`"));
    }
    let mut cmd = crate::platform::std_command(editor);
    cmd.arg(path);
    spawn_and_reap(&mut cmd, || {
        format!("could not launch {}", label_for(editor))
    })
}

/// Reveal `path` in the OS file manager, selecting it in its parent: macOS
/// `open -R`, Linux `xdg-open` (opens the directory), Windows `explorer /select`.
/// The path is an argv, never a shell string. Reaps the opener on a thread.
#[cfg(target_os = "macos")]
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let mut cmd = crate::platform::std_command("open");
    cmd.arg("-R").arg(path);
    spawn_and_reap(&mut cmd, || {
        "could not reveal the folder in Finder".to_string()
    })
}

/// Linux reveal: `xdg-open <dir>` opens the directory in the default file
/// manager (there is no portable reveal-and-select across managers).
#[cfg(all(unix, not(target_os = "macos")))]
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let mut cmd = crate::platform::std_command("xdg-open");
    cmd.arg(path);
    spawn_and_reap(&mut cmd, || "could not open the folder".to_string())
}

/// Windows reveal: `explorer /select,<path>` selects the entry in its parent.
#[cfg(windows)]
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let mut cmd = crate::platform::std_command("explorer");
    // `explorer` expects `/select,<path>` as a single token.
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path);
    cmd.arg(arg);
    spawn_and_reap(&mut cmd, || "could not open the folder".to_string())
}

/// Spawn `cmd` and reap the child on a detached thread so no zombie lingers and
/// the command never blocks the caller — the same pattern as `pr::open`'s
/// browser opener. `err` names the failure for the surfaced error string.
fn spawn_and_reap(
    cmd: &mut std::process::Command,
    err: impl FnOnce() -> String,
) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", err()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_editors_are_unique_and_nonempty() {
        // The allowlist is the security boundary — no blank commands, no dupes.
        let mut seen = std::collections::HashSet::new();
        for (cmd, label) in KNOWN_EDITORS {
            assert!(!cmd.is_empty(), "an editor command must be non-empty");
            assert!(!label.is_empty(), "an editor label must be non-empty");
            assert!(seen.insert(*cmd), "duplicate editor command `{cmd}`");
        }
    }

    #[test]
    fn detect_editors_only_returns_allowlisted_ids() {
        // Whatever is installed on the CI host, every detected id must be a known,
        // allowlisted command (never something off-list).
        for editor in detect_editors() {
            assert!(
                is_known(&editor.id),
                "detected editor `{}` is not on the allowlist",
                editor.id
            );
            assert_eq!(editor.label, label_for(&editor.id));
        }
    }

    #[test]
    fn resolve_editor_ignores_an_unrecognized_preference() {
        // A garbage / off-allowlist stored value must NOT be launched: resolution
        // falls through to auto-detect (which returns an installed known editor or
        // an error), never the untrusted string. In both outcomes the result is
        // never the poisoned value.
        let poisoned = "/bin/sh; rm -rf ~";
        match resolve_editor(Some(poisoned)) {
            Ok(chosen) => assert!(
                is_known(&chosen),
                "must resolve to an allowlisted editor, got `{chosen}`"
            ),
            Err(msg) => assert!(
                msg.contains("no supported editor"),
                "with nothing installed, the error is the no-editor message, got: {msg}"
            ),
        }
    }

    #[test]
    fn resolve_editor_errors_precisely_for_a_known_but_missing_editor() {
        // A recognized editor that isn't installed surfaces a named error rather
        // than silently launching a different one. `webstorm` is very unlikely to
        // be on a CI PATH; skip the assertion in the rare case it is.
        if which::which("webstorm").is_err() {
            let err = resolve_editor(Some("webstorm")).unwrap_err();
            assert!(
                err.contains("WebStorm") && err.contains("not installed"),
                "the error must name the missing editor, got: {err}"
            );
        }
    }

    #[test]
    fn resolve_editor_prefers_an_installed_known_pick() {
        // When the preference IS installed, it wins over the priority order. Use
        // the first actually-installed editor as the pick so the test is hermetic.
        if let Some(installed) = detect_editors().into_iter().next() {
            let chosen = resolve_editor(Some(&installed.id)).expect("installed pick resolves");
            assert_eq!(chosen, installed.id);
        }
    }

    #[test]
    fn open_in_editor_at_refuses_a_non_allowlisted_command() {
        // The launcher itself re-checks the allowlist (belt to `resolve_editor`'s
        // braces), so even a direct call can't spawn an off-list program.
        let err = open_in_editor_at("sh", Path::new("/tmp")).unwrap_err();
        assert!(err.contains("unknown editor"), "got: {err}");
    }
}
