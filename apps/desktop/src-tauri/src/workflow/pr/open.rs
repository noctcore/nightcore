//! The https-only external opener: validate a URL as `https` and hand it to the
//! OS default browser, reaping the child on a detached thread. Every other
//! scheme is rejected so a stored field can never launch a local resource.

/// Open `url` in the OS default browser — **https-only**. Every other scheme
/// (`http`, `file`, `javascript`, custom app schemes, …) is rejected, so a
/// stored task field or model output can never launch a local resource or
/// script through this seam. The URL is re-serialized from its parsed form
/// (normalized + percent-encoded) before it reaches the platform opener.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let normalized = validate_https_url(&url)?;
    open_in_browser(&normalized)
}

/// Parse + validate `url`: well-formed and scheme exactly `https`. Returns the
/// normalized serialization. Pure, unit-testable.
fn validate_https_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "refusing to open a non-https URL (scheme `{}`)",
            parsed.scheme()
        ));
    }
    Ok(parsed.to_string())
}

/// Hand a validated https URL to the platform's default-browser opener. The
/// child is reaped on a detached thread so no zombie lingers and the command
/// never blocks the caller.
#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> Result<(), String> {
    spawn_and_reap(crate::platform::std_command("open").arg(url))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(url: &str) -> Result<(), String> {
    spawn_and_reap(crate::platform::std_command("xdg-open").arg(url))
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    // `start` is a cmd builtin (the first quoted token is the window title). The
    // whole tail is passed via `raw_arg` with the URL explicitly quoted so cmd's
    // metacharacters (& | ^ < >) inside it stay literal; a validated https URL
    // (re-serialized by the parser, which percent-encodes `"`) cannot break out
    // of the quoting.
    use std::os::windows::process::CommandExt;
    let mut cmd = crate::platform::std_command("cmd");
    cmd.raw_arg(format!("/C start \"\" \"{url}\""));
    spawn_and_reap(&mut cmd)
}

/// Spawn `cmd` and reap the child on a detached thread (the openers exit almost
/// immediately after handing the URL to the browser).
fn spawn_and_reap(cmd: &mut std::process::Command) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not open the browser: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_external_accepts_only_https() {
        assert_eq!(
            validate_https_url("https://github.com/acme/widget/pull/7").as_deref(),
            Ok("https://github.com/acme/widget/pull/7")
        );
        for bad in [
            "http://github.com/acme/widget/pull/7", // downgrade
            "file:///etc/passwd",                   // local resource
            "javascript:alert(1)",                  // script
            "nightcore://internal",                 // custom scheme
            "ftp://host/file",                      // legacy scheme
            "github.com/acme/widget",               // no scheme
            "not a url at all",
            "",
        ] {
            assert!(
                validate_https_url(bad).is_err(),
                "must reject {bad:?} (https-only)"
            );
        }
    }
}
