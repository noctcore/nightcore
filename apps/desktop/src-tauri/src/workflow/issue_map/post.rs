//! The `gh` seam + the export orchestration (§3.2): issue-create, native
//! sub-issue-attach, close, and prior-map discovery — each binary-parameterized so
//! the tests inject a fake `gh` (the `post_issue_comment_with`/`create_pr_with`
//! fixture pattern). Every payload is built with `serde_json::json!` and posted on
//! STDIN via `--input -` (never argv); issue numbers/ids are `u64` decimal
//! (injection-safe); `{owner}`/`{repo}` resolve from the run's `project_path` as the
//! `gh` cwd. All runs are deadline-bounded so a black-holed GitHub errors out.
//!
//! The multi-issue create is NOT a transaction (§3.2.1): parent-first, then a
//! SEQUENTIAL create+attach per finding. A mid-run failure STOPS and returns a
//! structured partial [`IssueMapResult`] — nothing is ever deleted. A FIRST-attach
//! scope 404/403 (native sub-issues unavailable) degrades the whole run to task-list
//! linkage (§3.2.2); a transient attach failure does NOT degrade — it stops.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::contract::{IssueMapResult, Narrative, PriorMap};
use super::kind::ScanKind;
use super::plan::IssueMapPlan;
use super::render::{render_parent_body, render_sub_issue_body};
use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded, GhOutput};
use crate::task::sanitize_minted_title;
use crate::workflow::github_labels::{ensure_labels, NC_FINDING, NC_MAP};

/// Wall-clock bound on every issue-map `gh` spawn (create / attach / close / list).
pub(crate) const GH_TIMEOUT: Duration = Duration::from_secs(90);

/// A created issue's identifiers. `id` is the internal DATABASE id (what the
/// sub-issues attach endpoint wants, §10.1) — DISTINCT from the public `number`
/// (URLs, the parent task-list); capture BOTH.
struct CreatedIssue {
    id: u64,
    number: u64,
    url: String,
}

#[derive(Deserialize)]
struct PriorMapRow {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
}

/// Map a failed issue `gh api` call to an actionable message: `gh api` prints
/// GitHub's error JSON to STDOUT (stderr is only `gh: <status>`), so surface the
/// body's `errors[]`/`message` when present (the `map_post_failure` clone).
fn map_issue_failure(binary: &str, out: &GhOutput) -> String {
    let mut msg = map_gh_failure(binary, "api", out);
    if let Ok(v) = serde_json::from_str::<Value>(out.stdout.trim()) {
        let mut details: Vec<String> = v
            .get("errors")
            .and_then(Value::as_array)
            .map(|errs| {
                errs.iter()
                    .filter_map(|e| {
                        e.as_str()
                            .map(str::to_string)
                            .or_else(|| e.get("message")?.as_str().map(str::to_string))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if details.is_empty() {
            if let Some(top) = v.get("message").and_then(Value::as_str) {
                details.push(top.to_string());
            }
        }
        if !details.is_empty() {
            msg = format!("{msg}: {}", details.join("; "));
        }
    }
    msg
}

/// Create one issue via `gh api POST …/issues --input -`, capturing BOTH the internal
/// `id` and the public `number` (§10.1). Labels ride inline (they must already exist).
fn create_issue(
    dir: &Path,
    binary: &str,
    title: &str,
    body: &str,
    labels: &[&str],
    deadline: Duration,
) -> Result<CreatedIssue, String> {
    let payload = json!({ "title": title, "body": body, "labels": labels }).to_string();
    let out = run_gh_bounded(
        dir,
        binary,
        &[
            "api",
            "--method",
            "POST",
            "repos/{owner}/{repo}/issues",
            "--input",
            "-",
        ],
        Some(&payload),
        deadline,
        "timed out creating an issue on GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_issue_failure(binary, &out));
    }
    let v: Value = serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("`gh api` returned unparseable JSON creating an issue: {e}"))?;
    let id = v
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "the created-issue response carried no `id`".to_string())?;
    let number = v
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| "the created-issue response carried no `number`".to_string())?;
    let url = v
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(CreatedIssue { id, number, url })
}

/// Attach `sub_issue_id` (the child's internal DB `id`, NOT its number — §10.1) under
/// `parent_number` via the native sub-issues REST endpoint.
fn add_sub_issue(
    dir: &Path,
    binary: &str,
    parent_number: u64,
    sub_issue_id: u64,
    deadline: Duration,
) -> Result<(), String> {
    let payload = json!({ "sub_issue_id": sub_issue_id }).to_string();
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{parent_number}/sub_issues");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        Some(&payload),
        deadline,
        "timed out attaching a sub-issue on GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_issue_failure(binary, &out));
    }
    Ok(())
}

/// PATCH an issue's body (the degraded-linkage checklist bake-in, §3.2.2).
fn update_issue_body(
    dir: &Path,
    binary: &str,
    number: u64,
    body: &str,
    deadline: Duration,
) -> Result<(), String> {
    let payload = json!({ "body": body }).to_string();
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{number}");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "PATCH", &endpoint, "--input", "-"],
        Some(&payload),
        deadline,
        "timed out updating the map parent on GitHub",
    )?;
    if !out.status.success() {
        return Err(map_issue_failure(binary, &out));
    }
    Ok(())
}

/// Close an issue (`state: closed`, `state_reason: completed`) — the supersede path.
fn close_issue(dir: &Path, binary: &str, number: u64, deadline: Duration) -> Result<(), String> {
    let payload = json!({ "state": "closed", "state_reason": "completed" }).to_string();
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{number}");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "PATCH", &endpoint, "--input", "-"],
        Some(&payload),
        deadline,
        "timed out closing an issue on GitHub",
    )?;
    if !out.status.success() {
        return Err(map_issue_failure(binary, &out));
    }
    Ok(())
}

/// List a parent's sub-issues as `(number, state)` rows (the close-old-children path).
fn list_sub_issues(
    dir: &Path,
    binary: &str,
    parent: u64,
    deadline: Duration,
) -> Result<Vec<(u64, String)>, String> {
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{parent}/sub_issues");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", &endpoint],
        None,
        deadline,
        "timed out listing sub-issues on GitHub",
    )?;
    if !out.status.success() {
        return Err(map_issue_failure(binary, &out));
    }
    let v: Value = serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("`gh api` returned unparseable JSON listing sub-issues: {e}"))?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    Some((
                        c.get("number")?.as_u64()?,
                        c.get("state")
                            .and_then(Value::as_str)
                            .unwrap_or("open")
                            .to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Discover the prior open `nc:map` for this project+kind by label (§3.10 — no local
/// persistence). `gh issue list` returns newest first; take the newest.
pub(crate) fn find_prior_map(
    dir: &Path,
    binary: &str,
    kind: ScanKind,
    prefix: &str,
    deadline: Duration,
) -> Result<Option<PriorMap>, String> {
    let map_label = NC_MAP.full_name(prefix);
    let kind_label = kind.label().full_name(prefix);
    let out = run_gh_bounded(
        dir,
        binary,
        &[
            "issue",
            "list",
            "--label",
            &map_label,
            "--label",
            &kind_label,
            "--state",
            "open",
            "--json",
            "number,title,url",
            "--limit",
            "1",
        ],
        None,
        deadline,
        "timed out looking up the prior map on GitHub",
    )?;
    if !out.status.success() {
        return Err(map_gh_failure(binary, "issue list", &out));
    }
    let rows: Vec<PriorMapRow> = serde_json::from_str(out.stdout.trim()).unwrap_or_default();
    Ok(rows.into_iter().next().map(|r| PriorMap {
        number: r.number,
        title: r.title,
        url: r.url,
    }))
}

/// Close the superseded map (§3.10): its open children first, then the parent. Called
/// only when the user checked "close the old map"; best-effort (the caller surfaces a
/// failure as a warning, never an export failure).
pub(crate) fn close_superseded_map(
    dir: &Path,
    binary: &str,
    parent_number: u64,
    deadline: Duration,
) -> Result<(), String> {
    for (number, state) in list_sub_issues(dir, binary, parent_number, deadline)? {
        if state != "closed" {
            close_issue(dir, binary, number, deadline)?;
        }
    }
    close_issue(dir, binary, parent_number, deadline)
}

/// A `gh` failure signature meaning native sub-issues are UNAVAILABLE for this repo
/// (feature disabled or the token lacks scope) — the FIRST-attach 404/403 that
/// degrades the run. A transient/timeout signature is deliberately NOT matched.
fn is_scope_failure(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("404")
        || e.contains("not found")
        || e.contains("403")
        || e.contains("not accessible")
}

/// Build a STOP partial result (nothing deleted).
fn partial(
    parent: PriorMap,
    created: u32,
    attempted: u32,
    failed_at: usize,
    error: String,
    degraded: bool,
) -> IssueMapResult {
    IssueMapResult {
        parent,
        created,
        attempted,
        failed_at: Some(failed_at as u32),
        partial: true,
        error: Some(error),
        degraded_linkage: degraded,
        supersede_warning: None,
    }
}

/// Run the export (§3.2.1): ensure labels → create parent → SEQUENTIAL create+attach
/// per finding → optional supersede-close. `on_progress(created, attempted)` fires
/// after each attached child so the dialog can show `k/N`. Returns `Err` only when the
/// PARENT create fails (nothing exists); every later failure returns a structured
/// (possibly partial) [`IssueMapResult`].
#[allow(clippy::too_many_arguments)]
pub(crate) fn export_map(
    dir: &Path,
    binary: &str,
    prefix: &str,
    plan: &IssueMapPlan,
    narrative: &Narrative,
    generated_at: &str,
    supersedes: Option<&PriorMap>,
    close_superseded: bool,
    deadline: Duration,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<IssueMapResult, String> {
    probe_gh(binary, "install it to export the map to GitHub")?;

    let items: Vec<&super::plan::PlanItem> =
        plan.groups.iter().flat_map(|g| g.items.iter()).collect();
    let attempted = items.len() as u32;

    // Ensure the ≤5 labels once up front (under the configured prefix, so the export
    // honors the same `issue_label_prefix` as the sync writeback); a scope failure
    // degrades to no labels (§3.8).
    let kind_label = plan.kind.label();
    let labels_ok = ensure_labels(
        dir,
        binary,
        &[NC_MAP, NC_FINDING, kind_label],
        prefix,
        deadline,
    );
    let (map_name, finding_name, kind_name) = (
        NC_MAP.full_name(prefix),
        NC_FINDING.full_name(prefix),
        kind_label.full_name(prefix),
    );
    let parent_labels: Vec<&str> = if labels_ok {
        vec![map_name.as_str(), kind_name.as_str()]
    } else {
        Vec::new()
    };
    let child_labels: Vec<&str> = if labels_ok {
        vec![finding_name.as_str(), kind_name.as_str()]
    } else {
        Vec::new()
    };

    // Parent first (happy path) so a partial map is always a browsable parent.
    let parent_title = plan.parent_title();
    let parent_body = render_parent_body(plan, narrative, generated_at, supersedes, None);
    let parent = create_issue(
        dir,
        binary,
        &parent_title,
        &parent_body,
        &parent_labels,
        deadline,
    )?;
    let parent_ref = PriorMap {
        number: parent.number,
        title: parent_title,
        url: parent.url.clone(),
    };

    let mut created = 0u32;
    let mut degraded = false;
    let mut children: Vec<(u64, String)> = Vec::new();

    for (k, item) in items.iter().enumerate() {
        let title = sanitize_minted_title(&item.title, "Untitled finding");
        let body = render_sub_issue_body(plan.kind, &plan.run_id, item);
        let child = match create_issue(dir, binary, &title, &body, &child_labels, deadline) {
            Ok(c) => c,
            Err(e) => return Ok(partial(parent_ref, created, attempted, k, e, degraded)),
        };
        children.push((child.number, title));

        if degraded {
            // Already degraded — children are linked via the task-list checklist.
            created += 1;
            on_progress(created, attempted);
            continue;
        }
        match add_sub_issue(dir, binary, parent.number, child.id, deadline) {
            Ok(()) => {
                created += 1;
                on_progress(created, attempted);
            }
            Err(e) if created == 0 && is_scope_failure(&e) => {
                // FIRST-attach scope failure ⇒ native sub-issues unavailable: degrade
                // the whole run to task-list linkage and keep creating children (§3.2.2).
                tracing::warn!(target: "nightcore::issue_map", error = %e, "native sub-issues unavailable — degrading to task-list linkage");
                degraded = true;
                created += 1;
                on_progress(created, attempted);
            }
            Err(e) => {
                // A transient (or later) attach failure does NOT degrade — STOP.
                return Ok(partial(parent_ref, created, attempted, k, e, degraded));
            }
        }
    }

    // Under degradation, bake the checklist into the parent now that children exist.
    if degraded {
        let body = render_parent_body(plan, narrative, generated_at, supersedes, Some(&children));
        if let Err(e) = update_issue_body(dir, binary, parent.number, &body, deadline) {
            tracing::warn!(target: "nightcore::issue_map", error = %e, "could not bake the degraded checklist into the parent (children still created)");
        }
    }

    // Best-effort human-gated supersede-close.
    let mut supersede_warning = None;
    if close_superseded {
        if let Some(prior) = supersedes {
            if let Err(e) = close_superseded_map(dir, binary, prior.number, deadline) {
                supersede_warning = Some(e);
            }
        }
    }

    Ok(IssueMapResult {
        parent: parent_ref,
        created,
        attempted,
        failed_at: None,
        partial: false,
        error: None,
        degraded_linkage: degraded,
        supersede_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::issue_map::plan::build_insight_plan;
    use crate::workflow::issue_map::tests_support::insight_run;

    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    fn narrative() -> Narrative {
        Narrative {
            exec_summary: "Exec summary.".into(),
            group_intros: vec![],
        }
    }

    const T: Duration = Duration::from_secs(5);

    #[test]
    #[cfg(unix)]
    fn create_issue_posts_title_body_labels_and_parses_id_and_number() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\ncat > payload.json\n\
             printf '{\"id\":4242,\"number\":7,\"html_url\":\"https://h/7\"}'\nexit 0",
        );
        let bin = script.to_str().unwrap();
        let created = create_issue(tmp.path(), bin, "T", "B", &["nc:map", "nc:insight"], T)
            .expect("create ok");
        assert_eq!(created.id, 4242, "captures the internal DB id");
        assert_eq!(created.number, 7, "captures the public number");
        assert_eq!(created.url, "https://h/7");

        let payload: Value = serde_json::from_str(
            &std::fs::read_to_string(tmp.path().join("payload.json")).unwrap(),
        )
        .expect("payload json on stdin");
        assert_eq!(payload["title"], "T");
        assert_eq!(payload["body"], "B");
        assert_eq!(payload["labels"][0], "nc:map");
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).unwrap();
        assert!(
            args.contains("repos/{owner}/{repo}/issues"),
            "issues endpoint: {args}"
        );
        assert!(args.contains("--input"), "body rides on stdin: {args}");
        assert!(
            !args.contains("\"T\"") && !args.contains(" B "),
            "body/title not on argv"
        );
    }

    #[test]
    #[cfg(unix)]
    fn add_sub_issue_posts_the_internal_id_not_the_number() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\ncat > payload.json\nprintf '{}'\nexit 0",
        );
        let bin = script.to_str().unwrap();
        // parent number 7, child DB id 4242 — the attach body MUST carry the id (§10.1).
        add_sub_issue(tmp.path(), bin, 7, 4242, T).expect("attach ok");
        let payload: Value = serde_json::from_str(
            &std::fs::read_to_string(tmp.path().join("payload.json")).unwrap(),
        )
        .expect("payload");
        assert_eq!(
            payload["sub_issue_id"], 4242,
            "posts the id, not the number"
        );
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).unwrap();
        assert!(
            args.contains("repos/{owner}/{repo}/issues/7/sub_issues"),
            "attach endpoint under the parent NUMBER: {args}"
        );
    }

    /// A fake `gh` that routes by endpoint: labels/attach/list/PATCH succeed; each
    /// issue-create bumps a counter file and can be made to FAIL past a threshold.
    #[cfg(unix)]
    fn routing_gh(dir: &Path, attach_body: &str, fail_create_at: i32) -> std::path::PathBuf {
        let body = format!(
            "case \"$*\" in\n\
             *sub_issues*) if echo \"$*\" | grep -q -- '--input'; then {attach_body}; else printf '[]'; exit 0; fi ;;\n\
             *labels*) printf '{{}}'; exit 0 ;;\n\
             *'issue list'*) printf '[]'; exit 0 ;;\n\
             *PATCH*) printf '{{}}'; exit 0 ;;\n\
             *) n=$(cat n.txt 2>/dev/null || echo 0); n=$((n+1)); echo $n > n.txt;\n\
                if [ \"{fail_create_at}\" -gt 0 ] && [ \"$n\" -ge \"{fail_create_at}\" ]; then echo '{{\"message\":\"Server Error\"}}'; echo 'gh: Server Error (HTTP 500)' >&2; exit 1; fi;\n\
                printf '{{\"id\":%s,\"number\":%s,\"html_url\":\"https://h/%s\"}}' \"$((1000+n))\" \"$n\" \"$n\"; exit 0 ;;\n\
             esac"
        );
        fake_gh(dir, &body)
    }

    #[test]
    #[cfg(unix)]
    fn a_failure_at_child_k_stops_with_a_partial_result_and_deletes_nothing() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        // create #1 = parent, #2 = child0 (attach ok), #3 = child1 → FAILS.
        let script = routing_gh(tmp.path(), "cat >/dev/null; printf '{}'; exit 0", 3);
        let plan = build_insight_plan(&insight_run());
        let result = export_map(
            tmp.path(),
            script.to_str().unwrap(),
            "nc:",
            &plan,
            &narrative(),
            "2021-01-01T00:00:00Z",
            None,
            false,
            T,
            |_, _| {},
        )
        .expect("parent landed, so an Ok partial result");
        assert!(result.partial, "a mid-run failure is partial");
        assert_eq!(result.failed_at, Some(1), "stopped at child index 1");
        assert_eq!(result.created, 1, "only child 0 was created + attached");
        assert_eq!(result.attempted, plan.total());
        assert!(result.error.is_some(), "carries the mapped gh failure");
        assert!(
            !result.degraded_linkage,
            "a create failure is not a linkage degrade"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_first_attach_404_degrades_to_task_list_linkage_and_keeps_going() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        // The FIRST attach 404s (native sub-issues unavailable); creates never fail.
        let script = routing_gh(
            tmp.path(),
            "cat >/dev/null; echo '{\"message\":\"Not Found\"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1",
            0,
        );
        let plan = build_insight_plan(&insight_run());
        let result = export_map(
            tmp.path(),
            script.to_str().unwrap(),
            "nc:",
            &plan,
            &narrative(),
            "2021-01-01T00:00:00Z",
            None,
            false,
            T,
            |_, _| {},
        )
        .expect("export completes under degradation");
        assert!(result.degraded_linkage, "first-attach 404 degrades the run");
        assert!(!result.partial, "degradation is not a partial failure");
        assert_eq!(
            result.created,
            plan.total(),
            "all children created (linked via checklist)"
        );
        assert_eq!(result.failed_at, None);
    }

    #[test]
    #[cfg(unix)]
    fn find_prior_map_returns_the_open_map_or_none() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let present = fake_gh(
            tmp.path(),
            "printf '[{\"number\":5,\"title\":\"Old map\",\"url\":\"https://h/5\"}]'\nexit 0",
        );
        let prior = find_prior_map(
            tmp.path(),
            present.to_str().unwrap(),
            ScanKind::Insight,
            "nc:",
            T,
        )
        .expect("list ok");
        assert_eq!(prior.as_ref().map(|p| p.number), Some(5));
        assert_eq!(prior.unwrap().title, "Old map");

        let empty = fake_gh(tmp.path(), "printf '[]'\nexit 0");
        assert!(
            find_prior_map(
                tmp.path(),
                empty.to_str().unwrap(),
                ScanKind::Insight,
                "nc:",
                T
            )
            .expect("empty list ok")
            .is_none(),
            "no open map ⇒ None"
        );
    }

    #[test]
    #[cfg(unix)]
    fn close_superseded_map_lists_then_closes_open_children_and_the_parent() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        // GET children (no --input) → one open + one already-closed; PATCH closes record.
        let script = fake_gh(
            tmp.path(),
            "case \"$*\" in\n\
             *sub_issues*) printf '[{\"number\":6,\"state\":\"open\"},{\"number\":7,\"state\":\"closed\"}]'; exit 0 ;;\n\
             *) echo \"$*\" >> patched.txt; printf '{}'; exit 0 ;;\n\
             esac",
        );
        close_superseded_map(tmp.path(), script.to_str().unwrap(), 5, T).expect("close ok");
        let patched = std::fs::read_to_string(tmp.path().join("patched.txt")).unwrap();
        assert!(
            patched.contains("issues/6"),
            "the OPEN child #6 is closed: {patched}"
        );
        assert!(
            !patched.contains("issues/7"),
            "the already-closed child #7 is skipped"
        );
        assert!(
            patched.contains("issues/5"),
            "the parent #5 is closed: {patched}"
        );
    }
}
