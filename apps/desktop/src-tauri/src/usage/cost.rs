//! The popover-only local cost scan (spec §3.8), modeled on the Trust Report's
//! transcript summer (`store::transcript::cost_summary`).
//!
//! Computed ON DEMAND by the `get_usage_cost` command — NEVER on the 10-min poll —
//! so the compact bar's hot path stays network-only and a slow whole-tree JSONL
//! scan can't stall the loop. The result is ALWAYS labeled approximate: a $ estimate
//! from the same session transcripts the user's CLIs already wrote, priced with our
//! own bundled tables. An mtime short-circuit skips re-reading when nothing changed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::infra::time::iso8601_utc;
use crate::task::now_ms;
use crate::usage::contract::UsageCost;
use crate::usage::pricing::price_for;
use crate::workflow::trust::TokenTotals;

/// Only scan transcripts modified within this window — the estimate is a recent-usage
/// figure, and a bounded window keeps a whole-tree read cheap.
const SCAN_WINDOW_DAYS: u64 = 30;

/// In-memory, mtime-keyed cost cache (spec §3.8): hold the last result per provider
/// keyed by the max mtime seen; if no scanned file is newer, return the cache without
/// re-reading. Derived + cheap to rebuild — never persisted.
#[derive(Default)]
pub(crate) struct CostCache {
    entries: Mutex<HashMap<String, CachedCost>>,
}

struct CachedCost {
    max_mtime: u64,
    cost: UsageCost,
}

impl CostCache {
    /// The approximate local cost for `provider`, using the cache when no transcript
    /// is newer than the last scan.
    pub(crate) fn compute(&self, provider: &str) -> UsageCost {
        let files = collect_jsonl(&provider_dirs(provider));
        self.resolve(provider, &files, |paths| scan_dispatch(provider, paths))
    }

    /// The cache-aware core: short-circuit on an unchanged max mtime, else scan +
    /// store. Split out so tests can inject fabricated `(path, mtime)` pairs and a
    /// scan fn — exercising the short-circuit without touching real file mtimes.
    fn resolve(
        &self,
        provider: &str,
        files: &[(PathBuf, u64)],
        scan: impl FnOnce(&[PathBuf]) -> CostAccum,
    ) -> UsageCost {
        let max_mtime = files.iter().map(|(_, m)| *m).max().unwrap_or(0);
        if let Some(cached) = self.fresh(provider, max_mtime) {
            return cached;
        }
        let paths: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
        let cost = scan(&paths).into_usage_cost(provider);
        if let Ok(mut map) = self.entries.lock() {
            map.insert(
                provider.to_string(),
                CachedCost {
                    max_mtime,
                    cost: cost.clone(),
                },
            );
        }
        cost
    }

    /// The cached cost IFF it was computed at exactly `max_mtime` (nothing changed).
    fn fresh(&self, provider: &str, max_mtime: u64) -> Option<UsageCost> {
        let map = self.entries.lock().ok()?;
        let cached = map.get(provider)?;
        (cached.max_mtime == max_mtime).then(|| cached.cost.clone())
    }
}

/// Token + dollar accumulator (mirrors `store::transcript::CostSummary`).
#[derive(Default)]
struct CostAccum {
    tokens: TokenTotals,
    cost_usd: f64,
    saw_any: bool,
}

impl CostAccum {
    fn add(&mut self, model: &str, input: u64, output: u64, cache_read: u64, cache_creation: u64) {
        self.saw_any = true;
        self.tokens.input += input;
        self.tokens.output += output;
        self.tokens.cache_read += cache_read;
        self.tokens.cache_creation += cache_creation;
        if let Some(p) = price_for(model) {
            self.cost_usd += p.cost_usd(input, output, cache_read, cache_creation);
        }
    }

    /// Fold into the wire `UsageCost`. `None` cost/tokens when NO transcript was seen
    /// (never a misleading `$0` for a provider that simply hasn't run).
    fn into_usage_cost(self, provider: &str) -> UsageCost {
        UsageCost {
            provider: provider.to_string(),
            cost_usd: self.saw_any.then_some(self.cost_usd),
            tokens: self.saw_any.then_some(self.tokens),
            approximate: true,
            computed_at: iso8601_utc(now_ms()),
        }
    }
}

/// The transcript roots for a provider (spec §3.8).
fn provider_dirs(provider: &str) -> Vec<PathBuf> {
    match provider {
        "codex" => codex_dirs(),
        _ => claude_dirs(),
    }
}

fn claude_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(cfg) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|s| !s.is_empty()) {
        dirs.push(PathBuf::from(cfg).join("projects"));
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".claude").join("projects"));
    }
    dirs
}

fn codex_dirs() -> Vec<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")));
    match base {
        Some(b) => vec![b.join("sessions"), b.join("archived_sessions")],
        None => Vec::new(),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Every `*.jsonl` under `dirs` modified within the scan window, with its mtime.
/// Symlinks are never followed (a loop can't wedge the scan).
fn collect_jsonl(dirs: &[PathBuf]) -> Vec<(PathBuf, u64)> {
    let cutoff = (now_ms() / 1000).saturating_sub(SCAN_WINDOW_DAYS * 86_400);
    let mut out = Vec::new();
    for dir in dirs {
        walk(dir, cutoff, &mut out);
    }
    out
}

fn walk(dir: &Path, cutoff: u64, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            walk(&path, cutoff, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().ok().map(mtime_secs).unwrap_or(0);
        if mtime >= cutoff {
            out.push((path, mtime));
        }
    }
}

fn mtime_secs(meta: std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn scan_dispatch(provider: &str, paths: &[PathBuf]) -> CostAccum {
    match provider {
        "codex" => scan_codex_files(paths),
        _ => scan_claude_files(paths),
    }
}

/// Sum Claude SDK session JSONL: `type:"assistant"` lines with `message.usage`,
/// deduping streaming chunks by `message.id + requestId` so a re-persisted message
/// isn't double-counted.
fn scan_claude_files(paths: &[PathBuf]) -> CostAccum {
    let mut accum = CostAccum::default();
    let mut seen: HashSet<String> = HashSet::new();
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in raw.lines() {
            let Some(v) = parse_line(line) else { continue };
            if v.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some(msg) = v.get("message") else {
                continue;
            };
            let Some(usage) = msg.get("usage") else {
                continue;
            };
            let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
            let req = v.get("requestId").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() && !seen.insert(format!("{id}\u{1}{req}")) {
                continue; // a streaming chunk / re-persist of an already-counted message
            }
            let model = msg.get("model").and_then(Value::as_str).unwrap_or("");
            let u = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
            accum.add(
                model,
                u("input_tokens"),
                u("output_tokens"),
                u("cache_read_input_tokens"),
                u("cache_creation_input_tokens"),
            );
        }
    }
    accum
}

/// Sum Codex session JSONL: the LAST cumulative `token_count` per file (Codex totals
/// are cumulative, so only the final one counts), priced by the file's last
/// `turn_context` model marker.
fn scan_codex_files(paths: &[PathBuf]) -> CostAccum {
    let mut accum = CostAccum::default();
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut model = String::from("gpt-5-codex");
        let mut last: Option<(u64, u64, u64)> = None;
        for line in raw.lines() {
            let Some(v) = parse_line(line) else { continue };
            if let Some(m) = codex_model(&v) {
                model = m;
            }
            if let Some(tc) = codex_token_count(&v) {
                last = Some(tc);
            }
        }
        if let Some((input, output, cache_read)) = last {
            accum.add(&model, input, output, cache_read, 0);
        }
    }
    accum
}

/// The model id from a Codex `turn_context` (or a `payload.model`), if present.
fn codex_model(v: &Value) -> Option<String> {
    let direct = v.get("model").and_then(Value::as_str);
    let nested = v
        .get("payload")
        .and_then(|p| p.get("model"))
        .and_then(Value::as_str);
    direct
        .or(nested)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The cumulative token totals from a Codex `token_count` event, if this line is one.
fn codex_token_count(v: &Value) -> Option<(u64, u64, u64)> {
    let ty = v.get("type").and_then(Value::as_str);
    let info = match ty {
        Some("event_msg") => {
            let payload = v.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                return None;
            }
            payload.get("info").unwrap_or(payload)
        }
        Some("token_count") => v.get("info").unwrap_or(v),
        _ => return None,
    };
    let usage = info.get("total_token_usage").unwrap_or(info);
    let g = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = g("input_tokens");
    let output = g("output_tokens");
    let cache_read = usage
        .get("cached_input_tokens")
        .or_else(|| usage.get("cache_read_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 {
        return None;
    }
    Some((input, output, cache_read))
}

fn parse_line(line: &str) -> Option<Value> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn claude_sums_tokens_and_dollars_deduping_streaming_chunks() {
        let tmp = TempDir::new().unwrap();
        // Two assistant records for the SAME (id, requestId) — the second is a
        // re-persisted streaming chunk and must NOT be double-counted — plus a
        // distinct message and non-assistant noise.
        let content = "\
{\"type\":\"assistant\",\"requestId\":\"r1\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}
{\"type\":\"assistant\",\"requestId\":\"r1\",\"message\":{\"id\":\"m1\",\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":0}}}
{\"type\":\"user\",\"message\":{\"content\":\"noise\"}}
{\"type\":\"assistant\",\"requestId\":\"r2\",\"message\":{\"id\":\"m2\",\"model\":\"claude-opus-4-8\",\"usage\":{\"output_tokens\":1000000}}}
";
        let path = write(tmp.path(), "session.jsonl", content);
        let accum = scan_claude_files(&[path]);
        assert!(accum.saw_any);
        // 1M input (m1, counted once) + 1M output (m2) → $15 + $75 = $90.
        assert!(
            (accum.cost_usd - 90.0).abs() < 1e-6,
            "got {}",
            accum.cost_usd
        );
        assert_eq!(
            accum.tokens.input, 1_000_000,
            "the dup chunk didn't double-count"
        );
        assert_eq!(accum.tokens.output, 1_000_000);
    }

    #[test]
    fn codex_uses_the_last_cumulative_token_count() {
        let tmp = TempDir::new().unwrap();
        // token_count totals are cumulative — only the LAST is the session total.
        let content = "\
{\"type\":\"turn_context\",\"model\":\"gpt-5-codex\"}
{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cached_input_tokens\":0}}}}
{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000000,\"output_tokens\":1000000,\"cached_input_tokens\":0}}}}
";
        let path = write(tmp.path(), "rollout.jsonl", content);
        let accum = scan_codex_files(&[path]);
        // Last cumulative total: 1M in + 1M out → gpt-5 $1.25 + $10 = $11.25.
        assert_eq!(accum.tokens.input, 1_000_000);
        assert_eq!(accum.tokens.output, 1_000_000);
        assert!(
            (accum.cost_usd - 11.25).abs() < 1e-6,
            "got {}",
            accum.cost_usd
        );
    }

    #[test]
    fn no_transcripts_yields_none_not_zero() {
        let cost = CostAccum::default().into_usage_cost("claude");
        assert!(cost.cost_usd.is_none(), "no transcript → None, not $0");
        assert!(cost.tokens.is_none());
        assert!(cost.approximate);
        assert_eq!(cost.provider, "claude");
    }

    #[test]
    fn mtime_short_circuit_returns_the_cache_without_rereading() {
        let tmp = TempDir::new().unwrap();
        let path = write(
            tmp.path(),
            "s.jsonl",
            "{\"type\":\"assistant\",\"requestId\":\"r\",\"message\":{\"id\":\"a\",\"model\":\"claude-opus-4-8\",\"usage\":{\"input_tokens\":1000000}}}\n",
        );
        let cache = CostCache::default();
        // First resolve at a fixed fabricated mtime → scans, caches $15.
        let first = cache.resolve("claude", &[(path.clone(), 100)], scan_claude_files);
        assert_eq!(first.cost_usd, Some(15.0));

        // Overwrite the file with DIFFERENT content but resolve at the SAME mtime →
        // the short-circuit must return the ORIGINAL cached value, proving it did not
        // re-read the (now-changed) file.
        std::fs::write(
            &path,
            "{\"type\":\"assistant\",\"requestId\":\"r2\",\"message\":{\"id\":\"b\",\"model\":\"claude-opus-4-8\",\"usage\":{\"output_tokens\":1000000}}}\n",
        )
        .unwrap();
        let second = cache.resolve("claude", &[(path.clone(), 100)], scan_claude_files);
        assert_eq!(
            second.cost_usd,
            Some(15.0),
            "cache short-circuited the re-read"
        );

        // A NEWER mtime forces a rescan → now reflects the new content ($75 output).
        let third = cache.resolve("claude", &[(path, 200)], scan_claude_files);
        assert_eq!(
            third.cost_usd,
            Some(75.0),
            "a newer mtime invalidated the cache"
        );
    }
}
