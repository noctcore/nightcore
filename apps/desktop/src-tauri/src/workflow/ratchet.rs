//! Strictness ratchet (production-harness catalog #6): a one-way gate on type
//! and lint laxness. A user-triggered snapshot ([`snapshot`], via the
//! `snapshot_ratchet_baseline` command) counts the ACTIVE project's existing
//! `any` / `@ts-ignore` / `eslint-disable` occurrences into
//! `<project>/.nightcore/ratchet.json`; the verification gate then recounts in
//! the review dir and appends a `strictness-ratchet` [`StructureLockCheck`] —
//! Failed when any counter regressed above the baseline (naming each one,
//! baseline vs current), Passed otherwise (visible green proof the ratchet ran,
//! unlike the anti-gaming sweep whose pass is silent — laxness counters drift
//! silently, so the user should SEE the ratchet holding).
//!
//! Safety posture:
//!   - the baseline is written ONLY by the explicit snapshot command, and NEVER
//!     auto-tightened after a good build — auto-tightening would turn one
//!     accidental cleanup into a permanent gate the user didn't ask for;
//!   - absent/malformed baseline ⇒ append nothing (the ratchet is opt-in, like
//!     every `.nightcore/` gate) — malformed additionally warns;
//!   - counting failures in the review dir are infrastructure ⇒ warn and skip,
//!     never fail the gate;
//!   - the baseline write is atomic (temp file + rename via
//!     [`crate::store::write_atomic`], the same posture as the harness apply
//!     path) so a crash mid-snapshot can never leave a truncated gate config.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// The name AND kind of the appended check — a built-in, like `anti-gaming`.
const CHECK_NAME: &str = "strictness-ratchet";

/// The baseline file, project-root-relative (the review worktree never has it:
/// `.nightcore/` is gitignored).
const BASELINE_REL_PATH: &str = ".nightcore/ratchet.json";

/// The three laxness counters. Serde-additive: every field defaults so a future
/// counter can be added without invalidating existing baselines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatchetCounts {
    /// `: any` + `as any` + `<any>` occurrences (identifier-bounded, so
    /// `: anything` doesn't count).
    #[serde(default)]
    pub any: u64,
    /// `@ts-ignore` occurrences (`@ts-expect-error` is sanctioned and untracked).
    #[serde(default)]
    pub ts_ignore: u64,
    /// `eslint-disable` occurrences (all variants share the prefix).
    #[serde(default)]
    pub eslint_disable: u64,
}

/// The persisted `.nightcore/ratchet.json` shape: `{ "counts": { … } }`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct RatchetBaseline {
    counts: RatchetCounts,
}

/// Count the laxness occurrences across the project's git-tracked `*.ts`/`*.tsx`
/// files and persist them as the new baseline (atomic write). Errors are real
/// (this is a user-invoked action that must report failure, unlike the gate-side
/// reads which degrade silently).
pub fn snapshot(project_root: &Path) -> Result<RatchetCounts, String> {
    let counts = recount(project_root)?;
    let dir = project_root.join(".nightcore");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let json = serde_json::to_vec_pretty(&RatchetBaseline { counts })
        .map_err(|e| format!("failed to serialize ratchet baseline: {e}"))?;
    let path = project_root.join(BASELINE_REL_PATH);
    crate::store::write_atomic(&path, &json)
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    tracing::info!(target: "nightcore::ratchet", any = counts.any, ts_ignore = counts.ts_ignore, eslint_disable = counts.eslint_disable, "ratchet baseline snapshotted");
    Ok(counts)
}

/// Compare the review dir's recount against the project's baseline and append
/// the verdict check. Absent baseline ⇒ append nothing (opt-in gate); malformed
/// baseline or a failed recount ⇒ warn and append nothing (infrastructure never
/// fails the gate). The baseline is never rewritten here — see the module doc.
pub fn append_ratchet_check(
    result: &mut StructureLockResult,
    review_dir: &Path,
    project_root: &Path,
) {
    let Some(baseline) = read_baseline(project_root) else {
        return;
    };
    let current = match recount(review_dir) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "nightcore::ratchet", error = %e, dir = %review_dir.display(), "ratchet recount failed; skipping the check");
            return;
        }
    };
    let regressions = compare(&baseline, &current);
    // The "command" surfaced on the check is the reproducible measurement, so a
    // human can re-derive the counts the verdict is based on.
    let command =
        format!("git ls-files -z -- '*.ts' '*.tsx' | xargs -0 grep -c … (vs {BASELINE_REL_PATH})");
    if regressions.is_empty() {
        tracing::info!(target: "nightcore::ratchet", "strictness ratchet held");
        result.checks.push(StructureLockCheck {
            name: CHECK_NAME.to_string(),
            kind: CHECK_NAME.to_string(),
            command,
            status: StepStatus::Passed,
            exit_code: None,
            output: None,
        });
        return;
    }
    tracing::warn!(target: "nightcore::ratchet", regressed = regressions.len(), "strictness ratchet regressed; failing the gate");
    let output = format!(
        "Strictness ratchet regressed vs the {BASELINE_REL_PATH} baseline. Remove \
         the NEW occurrences (never loosen the baseline; `@ts-expect-error` is the \
         sanctioned suppression where one is genuinely required):\n{}",
        regressions
            .iter()
            .map(|r| format!("- {r}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    result.checks.push(StructureLockCheck {
        name: CHECK_NAME.to_string(),
        kind: CHECK_NAME.to_string(),
        command,
        status: StepStatus::Failed,
        exit_code: None,
        output: Some(output),
    });
    result.passed = false;
    if result.failed_check.is_none() {
        result.failed_check = Some(CHECK_NAME.to_string());
    }
}

/// Read the baseline. Absent ⇒ `None` silently (the opt-in path); malformed ⇒
/// warn and `None` (the user wrote a gate config that isn't being honored).
fn read_baseline(project_root: &Path) -> Option<RatchetCounts> {
    let raw = std::fs::read_to_string(project_root.join(BASELINE_REL_PATH)).ok()?;
    match serde_json::from_str::<RatchetBaseline>(&raw) {
        Ok(b) => Some(b.counts),
        Err(e) => {
            tracing::warn!(target: "nightcore::ratchet", error = %e, "malformed .nightcore/ratchet.json; skipping the ratchet");
            None
        }
    }
}

/// Count the laxness occurrences across the git-tracked `*.ts`/`*.tsx` files in
/// `dir` (git pathspecs match at any depth). Unreadable/non-UTF-8 files are
/// skipped — a binary that sneaked into the pathspec must not sink the count.
fn recount(dir: &Path) -> Result<RatchetCounts, String> {
    let out = crate::platform::git_command(dir)
        .args(["ls-files", "-z", "--", "*.ts", "*.tsx"])
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let listing = String::from_utf8_lossy(&out.stdout);
    let mut total = RatchetCounts::default();
    for rel in listing.split('\0').filter(|p| !p.is_empty()) {
        let Ok(src) = std::fs::read_to_string(dir.join(rel)) else {
            continue;
        };
        let c = count_source(&src);
        total.any += c.any;
        total.ts_ignore += c.ts_ignore;
        total.eslint_disable += c.eslint_disable;
    }
    Ok(total)
}

/// Count one file's laxness occurrences. Pure.
fn count_source(src: &str) -> RatchetCounts {
    RatchetCounts {
        any: count_token(src, ": any") + count_token(src, "as any") + count_token(src, "<any>"),
        ts_ignore: count_token(src, "@ts-ignore"),
        eslint_disable: count_token(src, "eslint-disable"),
    }
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// Non-overlapping occurrences of `needle` with identifier boundaries applied on
/// each side whose needle edge is itself an identifier char — so `as any` doesn't
/// fire inside `was any…` and `: any` doesn't count `: anything`, while `<any>`
/// (both edges non-identifier) is a plain substring count. Pure.
fn count_token(src: &str, needle: &str) -> u64 {
    let bound_left = needle.chars().next().is_some_and(is_ident);
    let bound_right = needle.chars().next_back().is_some_and(is_ident);
    let mut count = 0;
    let mut start = 0;
    while let Some(idx) = src[start..].find(needle) {
        let abs = start + idx;
        let end = abs + needle.len();
        let left_ok = !bound_left || !src[..abs].chars().next_back().is_some_and(is_ident);
        let right_ok = !bound_right || !src[end..].chars().next().is_some_and(is_ident);
        if left_ok && right_ok {
            count += 1;
            start = end;
        } else {
            start = abs + 1;
        }
    }
    count
}

/// The regressed counters, each rendered `name: baseline → current (+delta)`
/// with the wire (camelCase) counter names. Empty ⇒ the ratchet held. An
/// IMPROVED counter is simply not listed — the baseline is never auto-tightened
/// to capture it (see the module doc). Pure.
fn compare(baseline: &RatchetCounts, current: &RatchetCounts) -> Vec<String> {
    let pairs = [
        ("any", baseline.any, current.any),
        ("tsIgnore", baseline.ts_ignore, current.ts_ignore),
        (
            "eslintDisable",
            baseline.eslint_disable,
            current.eslint_disable,
        ),
    ];
    pairs
        .iter()
        .filter(|(_, base, cur)| cur > base)
        .map(|(name, base, cur)| format!("{name}: {base} → {cur} (+{})", cur - base))
        .collect()
}

// ─── Command ────────────────────────────────────────────────────────────────────

/// Snapshot the ACTIVE project's ratchet baseline (the explicit, user-triggered
/// tightening action). The body walks every tracked TS file — seconds on a large
/// repo — so it runs on the blocking pool with state re-acquired from the owned
/// `AppHandle` (the `commit_task` async-command pattern), keeping the WKWebView
/// thread free.
#[tauri::command]
pub async fn snapshot_ratchet_baseline(app: AppHandle) -> Result<RatchetCounts, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot_baseline_blocking(&app))
        .await
        .map_err(|e| format!("ratchet snapshot failed to run: {e}"))?
}

/// The blocking body of `snapshot_ratchet_baseline`. `try_state` (not `state`)
/// so an unmanaged store fails the command gracefully instead of panicking on
/// the pool.
fn snapshot_baseline_blocking(app: &AppHandle) -> Result<RatchetCounts, String> {
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    let project = projects
        .active()
        .ok_or_else(|| "no active project".to_string())?;
    snapshot(Path::new(&project.path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_source_counts_the_any_family_with_boundaries() {
        let src = "const a: any = x as any;\nlet b: Array<any> = [];\nfunction f(): anything {}\nconst was = `was anywhere`;\ntype T = Record<string, any>;\n";
        let c = count_source(src);
        // Counted: `: any` (the declaration), `as any`, `<any>` (Array) = 3.
        // Boundary-rejected: `: anything`, `was any…`; `Record<string, any>` has
        // none of the three shapes.
        assert_eq!(c.any, 3, "src: {src}");
        assert_eq!(c.ts_ignore, 0);
        assert_eq!(c.eslint_disable, 0);
    }

    #[test]
    fn count_source_counts_suppressions_but_not_ts_expect_error() {
        let src = "// @ts-ignore\n// @ts-expect-error legit\n/* eslint-disable */\n// eslint-disable-next-line no-console\n";
        let c = count_source(src);
        assert_eq!(c.ts_ignore, 1, "@ts-expect-error is not @ts-ignore");
        assert_eq!(c.eslint_disable, 2, "all eslint-disable variants count");
    }

    #[test]
    fn count_token_handles_adjacent_and_boundary_cases() {
        assert_eq!(count_token("as any as any", "as any"), 2);
        assert_eq!(count_token("was any", "as any"), 0, "left boundary");
        assert_eq!(count_token(": anything", ": any"), 0, "right boundary");
        assert_eq!(count_token(": any[]", ": any"), 1, "`any[]` is still any");
        assert_eq!(count_token("<any><any>", "<any>"), 2);
        assert_eq!(count_token("", ": any"), 0);
    }

    #[test]
    fn compare_lists_only_regressions_with_wire_names() {
        let baseline = RatchetCounts {
            any: 41,
            ts_ignore: 5,
            eslint_disable: 3,
        };
        // Improvement + hold ⇒ nothing listed.
        let better = RatchetCounts {
            any: 40,
            ts_ignore: 5,
            eslint_disable: 0,
        };
        assert!(compare(&baseline, &better).is_empty());

        let worse = RatchetCounts {
            any: 44,
            ts_ignore: 5,
            eslint_disable: 4,
        };
        let regressions = compare(&baseline, &worse);
        assert_eq!(
            regressions,
            vec!["any: 41 → 44 (+3)", "eslintDisable: 3 → 4 (+1)"],
            "each regressed counter is named with its wire name and delta"
        );
    }

    #[test]
    fn counts_serialize_with_wire_names_and_tolerate_missing_fields() {
        let counts = RatchetCounts {
            any: 1,
            ts_ignore: 2,
            eslint_disable: 3,
        };
        let json = serde_json::to_value(RatchetBaseline { counts }).unwrap();
        assert_eq!(json["counts"]["any"], 1);
        assert_eq!(json["counts"]["tsIgnore"], 2);
        assert_eq!(json["counts"]["eslintDisable"], 3);
        // Serde-additive: a baseline written before a future counter still parses.
        let sparse: RatchetBaseline =
            serde_json::from_str(r#"{ "counts": { "any": 7 } }"#).unwrap();
        assert_eq!(sparse.counts.any, 7);
        assert_eq!(sparse.counts.ts_ignore, 0);
    }

    #[test]
    fn absent_or_malformed_baseline_appends_nothing() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let mut result = StructureLockResult::empty_pass();
        append_ratchet_check(&mut result, tmp.path(), tmp.path());
        assert!(result.passed && result.checks.is_empty(), "absent ⇒ silent");

        std::fs::create_dir_all(tmp.path().join(".nightcore")).expect("mkdir");
        std::fs::write(tmp.path().join(BASELINE_REL_PATH), "{ nope").expect("write");
        append_ratchet_check(&mut result, tmp.path(), tmp.path());
        assert!(
            result.passed && result.checks.is_empty(),
            "malformed ⇒ skip"
        );
    }

    /// The full real-git ratchet cycle: snapshot a baseline, hold ⇒ visible
    /// Passed check; regress ⇒ Failed check naming the counter; untracked files
    /// never count. Skips when `git` is unavailable.
    #[test]
    fn snapshot_then_ratchet_holds_and_regresses() {
        use std::process::Command;
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        std::fs::write(repo.join("a.ts"), "const a: any = 1;\n// @ts-ignore\n").expect("write");
        std::fs::write(repo.join("b.md"), ": any as any <any>").expect("write"); // not a TS file
        assert!(run(&["add", "."]) && run(&["commit", "-q", "-m", "ts files"]));
        // An UNTRACKED laxness dump must not count (ls-files scope).
        std::fs::write(repo.join("scratch.ts"), "x as any; y as any;\n").expect("write");

        let counts = snapshot(&repo).expect("snapshot");
        assert_eq!(
            counts,
            RatchetCounts {
                any: 1,
                ts_ignore: 1,
                eslint_disable: 0
            }
        );
        assert!(
            repo.join(BASELINE_REL_PATH).exists(),
            "the baseline was persisted"
        );

        // Unchanged tree ⇒ the ratchet holds with a VISIBLE Passed check.
        let mut held = StructureLockResult::empty_pass();
        append_ratchet_check(&mut held, &repo, &repo);
        assert!(held.passed);
        assert_eq!(held.checks.len(), 1, "the pass is visible, not silent");
        assert_eq!(held.checks[0].name, "strictness-ratchet");
        assert_eq!(held.checks[0].status, StepStatus::Passed);

        // Regressing a TRACKED file fails the gate, naming the counter.
        std::fs::write(
            repo.join("a.ts"),
            "const a: any = 1;\nconst b = x as any;\n// @ts-ignore\n",
        )
        .expect("write");
        let mut regressed = StructureLockResult::empty_pass();
        append_ratchet_check(&mut regressed, &repo, &repo);
        assert!(!regressed.passed);
        assert_eq!(
            regressed.failed_check.as_deref(),
            Some("strictness-ratchet")
        );
        let output = regressed.checks[0].output.as_deref().unwrap();
        assert!(output.contains("any: 1 → 2 (+1)"), "{output}");
        assert!(
            !output.contains("tsIgnore:"),
            "held counters are not listed: {output}"
        );

        // The baseline was NOT auto-tightened by either verdict.
        let baseline = read_baseline(&repo).expect("baseline still readable");
        assert_eq!(baseline.any, 1, "never auto-tightened");
    }

    /// Real git repo, or `None` when git is unavailable.
    fn temp_repo() -> Option<(tempfile::TempDir, std::path::PathBuf)> {
        use std::process::Command;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let path = tmp.path().to_path_buf();
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q"]) {
            return None;
        }
        run(&["config", "user.email", "t@t.t"]);
        run(&["config", "user.name", "t"]);
        // Mirror production: `.nightcore/` (where the baseline lands) is ignored.
        std::fs::write(path.join(".gitignore"), ".nightcore/\nscratch.ts\n").ok()?;
        std::fs::write(path.join("README.md"), "hi").ok()?;
        run(&["add", "."]);
        if !run(&["commit", "-q", "-m", "init"]) {
            return None;
        }
        Some((tmp, path))
    }
}
