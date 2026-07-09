//! First-run onboarding diagnostics.
//!
//! These commands intentionally only observe local CLI readiness. Nightcore does
//! not install tools, mutate auth, or store credentials; the CLIs remain owned by
//! the user's shell and keychain.

use std::io::Read;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

const CHECK_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingPrerequisites {
    pub claude: ToolCheck,
    pub codex: ToolCheck,
    pub gh: ToolCheck,
    pub git: ToolCheck,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub authenticated: Option<bool>,
    pub path: Option<String>,
    pub version: Option<String>,
    pub detail: String,
    pub fix_hint: String,
    pub fix_command: String,
}

#[tauri::command]
pub async fn check_onboarding_prerequisites() -> Result<OnboardingPrerequisites, String> {
    tauri::async_runtime::spawn_blocking(check_onboarding_prerequisites_blocking)
        .await
        .map_err(|e| format!("onboarding checks failed to run: {e}"))
}

fn check_onboarding_prerequisites_blocking() -> OnboardingPrerequisites {
    OnboardingPrerequisites {
        claude: check_auth_tool(
            "claude",
            "Claude Code",
            &["auth", "status"],
            "Install Claude Code, then authenticate it.",
            "claude auth login",
        ),
        codex: check_codex_tool(),
        gh: check_auth_tool(
            "gh",
            "GitHub CLI",
            &["auth", "status"],
            "Install GitHub CLI, then authenticate it.",
            "gh auth login",
        ),
        git: check_installed_tool(
            "git",
            "Git",
            &["--version"],
            "Install Git and make sure it is available on PATH.",
            "git --version",
        ),
    }
}

fn check_auth_tool(
    binary: &str,
    label: &str,
    auth_args: &[&str],
    fix_hint: &str,
    fix_command: &str,
) -> ToolCheck {
    let Some(path) = which::which(binary).ok() else {
        return ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: false,
            authenticated: Some(false),
            path: None,
            version: None,
            detail: "not installed".to_string(),
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        };
    };

    let version = tool_version(binary);
    match run_probe(binary, auth_args) {
        ProbeResult::Success(text) => ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: true,
            authenticated: Some(true),
            path: Some(path.display().to_string()),
            version,
            detail: auth_detail(binary, true, &text),
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        },
        ProbeResult::Failure(text) => ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: auth_detail(binary, false, &text),
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        },
        ProbeResult::TimedOut => ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: "auth check timed out".to_string(),
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        },
        ProbeResult::CouldNotLaunch(text) => ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: text,
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        },
    }
}

fn check_installed_tool(
    binary: &str,
    label: &str,
    args: &[&str],
    fix_hint: &str,
    fix_command: &str,
) -> ToolCheck {
    let Some(path) = which::which(binary).ok() else {
        return ToolCheck {
            id: binary.to_string(),
            label: label.to_string(),
            installed: false,
            authenticated: None,
            path: None,
            version: None,
            detail: "not installed".to_string(),
            fix_hint: fix_hint.to_string(),
            fix_command: fix_command.to_string(),
        };
    };

    let version = tool_version(binary);
    let detail = match run_probe(binary, args) {
        ProbeResult::Success(text) => first_line_or(&text, "installed"),
        ProbeResult::Failure(text) => first_line_or(&text, "installed; version check failed"),
        ProbeResult::TimedOut => "installed; version check timed out".to_string(),
        ProbeResult::CouldNotLaunch(text) => text,
    };

    ToolCheck {
        id: binary.to_string(),
        label: label.to_string(),
        installed: true,
        authenticated: None,
        path: Some(path.display().to_string()),
        version,
        detail,
        fix_hint: fix_hint.to_string(),
        fix_command: fix_command.to_string(),
    }
}

fn tool_version(binary: &str) -> Option<String> {
    match run_probe(binary, &["--version"]) {
        ProbeResult::Success(text) => Some(first_line_or(&text, "installed")),
        _ => None,
    }
}

fn check_codex_tool() -> ToolCheck {
    const LABEL: &str = "Codex CLI";
    const INSTALL_HINT: &str = "Install Codex CLI, then authenticate it.";
    const INSTALL_COMMAND: &str = "npm install -g @openai/codex";
    const LOGIN_COMMAND: &str = "codex login";

    let Some(path) = which::which("codex").ok() else {
        return ToolCheck {
            id: "codex".to_string(),
            label: LABEL.to_string(),
            installed: false,
            authenticated: Some(false),
            path: None,
            version: None,
            detail: "not installed".to_string(),
            fix_hint: INSTALL_HINT.to_string(),
            fix_command: INSTALL_COMMAND.to_string(),
        };
    };

    let version = tool_version("codex");
    match run_probe("codex", &["login", "status"]) {
        ProbeResult::Success(text) => ToolCheck {
            id: "codex".to_string(),
            label: LABEL.to_string(),
            installed: true,
            authenticated: Some(true),
            path: Some(path.display().to_string()),
            version,
            detail: auth_detail("codex", true, &text),
            fix_hint: INSTALL_HINT.to_string(),
            fix_command: LOGIN_COMMAND.to_string(),
        },
        ProbeResult::Failure(text) => ToolCheck {
            id: "codex".to_string(),
            label: LABEL.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: auth_detail("codex", false, &text),
            fix_hint: INSTALL_HINT.to_string(),
            fix_command: LOGIN_COMMAND.to_string(),
        },
        ProbeResult::TimedOut => ToolCheck {
            id: "codex".to_string(),
            label: LABEL.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: "auth check timed out".to_string(),
            fix_hint: INSTALL_HINT.to_string(),
            fix_command: LOGIN_COMMAND.to_string(),
        },
        ProbeResult::CouldNotLaunch(text) => ToolCheck {
            id: "codex".to_string(),
            label: LABEL.to_string(),
            installed: true,
            authenticated: Some(false),
            path: Some(path.display().to_string()),
            version,
            detail: text,
            fix_hint: INSTALL_HINT.to_string(),
            fix_command: LOGIN_COMMAND.to_string(),
        },
    }
}

fn auth_detail(binary: &str, authenticated: bool, text: &str) -> String {
    if binary == "claude" || binary == "codex" {
        return if authenticated {
            "authenticated".to_string()
        } else {
            "not logged in on this machine".to_string()
        };
    }
    if authenticated {
        first_line_or(text, "authenticated")
    } else {
        first_line_or(text, "authentication required")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeResult {
    Success(String),
    Failure(String),
    TimedOut,
    CouldNotLaunch(String),
}

fn run_probe(binary: &str, args: &[&str]) -> ProbeResult {
    let mut child = match crate::platform::std_command(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return ProbeResult::CouldNotLaunch(format!("could not launch: {e}")),
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_pipe(stdout));
    let err_reader = std::thread::spawn(move || read_pipe(stderr));

    let status = match crate::infra::proc::wait_with_deadline(&mut child, CHECK_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => return ProbeResult::TimedOut,
        Err(e) => return ProbeResult::CouldNotLaunch(format!("could not wait: {e}")),
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let text = if stderr.trim().is_empty() {
        stdout
    } else if stdout.trim().is_empty() {
        stderr
    } else {
        format!("{stdout}\n{stderr}")
    };

    if status.success() {
        ProbeResult::Success(text)
    } else {
        ProbeResult::Failure(text)
    }
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut text = String::new();
    let _ = pipe.read_to_string(&mut text);
    text
}

fn first_line_or(text: &str, fallback: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback);
    truncate_detail(line)
}

fn truncate_detail(line: &str) -> String {
    const MAX_CHARS: usize = 140;
    let mut chars = line.chars();
    let clipped: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{clipped}...")
    } else {
        clipped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_skips_blank_lines_and_truncates() {
        let long = format!("\n\n{}", "x".repeat(160));
        let got = first_line_or(&long, "fallback");
        assert_eq!(got.chars().count(), 143);
        assert!(got.ends_with("..."));
    }

    #[test]
    fn first_line_uses_fallback_for_empty_output() {
        assert_eq!(first_line_or(" \n\t", "fallback"), "fallback");
    }
}
