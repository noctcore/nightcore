//! Read the OAuth credentials the user's `claude` / `codex` CLIs already wrote
//! (spec §3.4a). READ-ONLY: this module never writes, refreshes, or rotates a
//! credential (spec decision 4). A credential is read at poll time and dropped when
//! the request completes — it lives no longer than the fetch (spec §3.7).
//!
//! - **Claude:** on macOS, the Keychain generic-password item `Claude Code-credentials`
//!   (via `security-framework`); everywhere else (and as a macOS fallback) the file
//!   `~/.claude/.credentials.json`. Same JSON shape either way.
//! - **Codex:** `$CODEX_HOME/auth.json` else `~/.codex/auth.json` — a plain file
//!   read on every platform (no Keychain).
//!
//! The parse functions are PURE over the credential blob (unit-tested); the read
//! functions do the I/O.

use std::path::PathBuf;

use serde_json::Value;

use crate::usage::http::FetchError;

/// The Claude usage fetch needs only the OAuth access token (the rest of the blob —
/// refresh token, expiry, scopes — is deliberately NOT extracted; we never refresh).
pub(crate) struct ClaudeCreds {
    pub(crate) access_token: String,
}

/// The Codex usage fetch needs the access token + the ChatGPT account id (the
/// `ChatGPT-Account-Id` header, spec §3.4c).
pub(crate) struct CodexCreds {
    pub(crate) access_token: String,
    pub(crate) account_id: String,
}

/// Read Claude's OAuth access token: Keychain first on macOS, then the file
/// fallback. `NoCreds` when neither yields a usable `claudeAiOauth.accessToken`
/// (including the MCP-only state, spec §3.4a trap #1844 — a payload with `mcpOAuth`
/// but no `claudeAiOauth` carries no usable token, so we never attempt a fetch).
pub(crate) fn read_claude_creds() -> Result<ClaudeCreds, FetchError> {
    #[cfg(target_os = "macos")]
    if let Some(blob) = read_claude_keychain() {
        if let Some(creds) = parse_claude_blob(&blob) {
            return Ok(creds);
        }
    }
    if let Some(path) = claude_creds_file() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(creds) = parse_claude_blob(&raw) {
                return Ok(creds);
            }
        }
    }
    Err(FetchError::NoCreds)
}

/// Touch the credential seams so the macOS Keychain access prompt fires as a
/// CONSEQUENCE of the enable gesture (spec decision 5), not as a surprise background
/// prompt. Results are discarded — this only front-runs the prompt onto the click;
/// the poll loop does the real read. Must run on the blocking pool (a Keychain read
/// can block on the prompt). Tokens are dropped immediately, never surfaced.
pub(crate) fn prime_credentials() {
    let _ = read_claude_creds();
    let _ = read_codex_creds();
}

/// Read Codex's OAuth access token + account id from `auth.json`. `NoCreds` when the
/// file is absent or carries no `tokens.access_token`.
pub(crate) fn read_codex_creds() -> Result<CodexCreds, FetchError> {
    let path = codex_auth_file().ok_or(FetchError::NoCreds)?;
    let raw = std::fs::read_to_string(&path).map_err(|_| FetchError::NoCreds)?;
    parse_codex_blob(&raw).ok_or(FetchError::NoCreds)
}

/// Parse a Claude credentials blob (`{ "claudeAiOauth": { "accessToken", … } }`).
/// `None` when there is no non-empty `claudeAiOauth.accessToken` — which is ALSO the
/// MCP-only state (`mcpOAuth` present, `claudeAiOauth` absent), so an MCP-only
/// payload correctly yields no creds and never triggers a fetch.
pub(crate) fn parse_claude_blob(raw: &str) -> Option<ClaudeCreds> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let token = v
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())?;
    Some(ClaudeCreds {
        access_token: token.to_string(),
    })
}

/// Parse a Codex `auth.json` blob (`{ "tokens": { "access_token", "account_id" } }`).
/// `None` without a non-empty `tokens.access_token`; `account_id` defaults to empty
/// (the header is still sent — an absent id degrades server-side to `Unsupported`,
/// never a panic).
pub(crate) fn parse_codex_blob(raw: &str) -> Option<CodexCreds> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let tokens = v.get("tokens")?;
    let token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())?;
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(CodexCreds {
        access_token: token.to_string(),
        account_id,
    })
}

/// The user's home directory from the environment (`HOME` on unix, `USERPROFILE` on
/// Windows). Reads the env directly to avoid a new crate dependency (mirrors
/// `sidecar::models::home_dir`).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `$CLAUDE_CONFIG_DIR/.credentials.json` (when set), else `<home>/.claude/.credentials.json`.
fn claude_creds_file() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join(".credentials.json"));
        }
    }
    home_dir().map(|h| h.join(".claude").join(".credentials.json"))
}

/// `$CODEX_HOME/auth.json` (when set), else `<home>/.codex/auth.json`.
fn codex_auth_file() -> Option<PathBuf> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        if !codex_home.is_empty() {
            return Some(PathBuf::from(codex_home).join("auth.json"));
        }
    }
    home_dir().map(|h| h.join(".codex").join("auth.json"))
}

/// Read the Claude `Claude Code-credentials` Keychain generic-password item as its
/// raw JSON blob (macOS only). Queries by SERVICE only (matching how the `security`
/// CLI + the CLI itself store it), returns the first item's data. ANY failure
/// (item absent, access denied, decode error) yields `None`, so the caller falls
/// through to the file — never a crash, never a surfaced token.
#[cfg(target_os = "macos")]
fn read_claude_keychain() -> Option<String> {
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};

    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service("Claude Code-credentials")
        .load_data(true)
        .limit(1i64)
        .search()
        .ok()?;
    results.into_iter().find_map(|r| match r {
        SearchResult::Data(bytes) => String::from_utf8(bytes).ok(),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_claude_oauth_blob() {
        let blob = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r",
            "expiresAt":1700000000000,"scopes":["user:profile"],"subscriptionType":"max"}}"#;
        let creds = parse_claude_blob(blob).expect("a real oauth blob parses");
        assert_eq!(creds.access_token, "sk-ant-oat01-abc");
    }

    #[test]
    fn mcp_only_claude_blob_yields_no_creds() {
        // Research #1844: a Claude-Code-2.1.x state carries `mcpOAuth` but no
        // `claudeAiOauth` → NO usable token → None (the poller renders NotConnected
        // and never attempts a fetch).
        let blob = r#"{"mcpOAuth":{"someServer":{"accessToken":"x"}}}"#;
        assert!(parse_claude_blob(blob).is_none());
    }

    #[test]
    fn empty_or_garbage_claude_blob_yields_no_creds() {
        assert!(parse_claude_blob("").is_none());
        assert!(parse_claude_blob("not json").is_none());
        assert!(parse_claude_blob(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
        assert!(parse_claude_blob(r#"{"claudeAiOauth":{}}"#).is_none());
    }

    #[test]
    fn parses_a_codex_auth_blob_with_and_without_account() {
        let blob = r#"{"tokens":{"access_token":"eyJhbGciOi.abc.def","account_id":"acct_123",
            "id_token":"x"},"last_refresh":"2026-07-11T00:00:00Z"}"#;
        let creds = parse_codex_blob(blob).expect("a real auth blob parses");
        assert_eq!(creds.access_token, "eyJhbGciOi.abc.def");
        assert_eq!(creds.account_id, "acct_123");

        // account_id absent → empty (still fetchable; server-side maps to Unsupported).
        let no_acct = r#"{"tokens":{"access_token":"tok"}}"#;
        let creds = parse_codex_blob(no_acct).expect("token-only blob parses");
        assert_eq!(creds.account_id, "");
    }

    #[test]
    fn empty_or_garbage_codex_blob_yields_no_creds() {
        assert!(parse_codex_blob("").is_none());
        assert!(parse_codex_blob(r#"{"tokens":{}}"#).is_none());
        assert!(parse_codex_blob(r#"{"tokens":{"access_token":""}}"#).is_none());
        assert!(parse_codex_blob(r#"{}"#).is_none());
    }
}
