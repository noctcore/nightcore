//! Review-post SURVIVABILITY: validate each inline comment's `(path, line)` anchor
//! against the PR's CURRENT diff, DEMOTE the ones that don't anchor into the review body
//! (never drop them, never fail the whole post), and note the head the review was computed
//! against. Pure + unit-testable; the blocking layer in [`super::post`] feeds it the diff +
//! head SHAs it fetched via the `gh` seam.
//!
//! Why: GitHub's `POST …/reviews` validates every inline comment's `line` against the
//! diff and 422s the ENTIRE review (body + all comments) on a single anchor outside the
//! diff — so one stale/out-of-diff finding would sink the whole post. We
//! UNDER-approximate the valid-anchor set (only RIGHT-side context + added lines — the
//! anchors GitHub accepts for a default-side inline review comment) so a KEPT comment
//! never 422s; a comment we cannot prove anchorable is demoted to text rather than risked
//! inline.
//!
//! What re-anchoring does and does NOT guarantee: validating against the freshly-fetched
//! diff guarantees no comment ever posts OUTSIDE the current diff (no 422). It does NOT
//! guarantee the line still points at the SAME code the review read — a head that advanced
//! (inserting lines above) can leave a still-valid anchor pointing a few lines off. That
//! residual is inherent to line-anchored review comments and can't be closed in this slice;
//! the head note ([`HeadStatus`]) is the honesty signal for it.
//!
//! Trust: the review summary body is Nightcore-composed. But a finding's `file` (the path,
//! chosen by the untrusted PR author) and `body` (model prose derived from reading the
//! untrusted diff) are UNTRUSTED and, worse, the demote section is composed HERE — after
//! the web approval gate — so the approver never sees this exact text. Every untrusted
//! value is run through [`sanitize_untrusted_md`] before embedding so it cannot inject a
//! live `@`-mention, link, image, raw HTML, or code-span breakout into a review posted
//! under the reviewing user's own GitHub identity. The two head SHAs are GitHub-provided
//! hex OIDs (not attacker text).

use std::collections::{HashMap, HashSet};

use super::post::InlineComment;

/// How the head the review was computed against relates to the head the freshly-fetched
/// diff reflects. Drives the honest note prepended to the posted body — and it NEVER
/// silently passes: an unverifiable head is surfaced, not hidden.
pub(super) enum HeadStatus {
    /// Reviewed head known and equal to the current head — nothing to note.
    Current,
    /// Reviewed head known and DIFFERENT from the current head — the PR advanced.
    Moved { reviewed: String, current: String },
    /// The reviewed head couldn't be verified: the run recorded no head SHA, or the
    /// current head was unreadable. We can't confirm the anchors reflect the reviewed
    /// code, so we say so.
    Unverified,
}

/// A review made survivable: the inline `comments` that anchor cleanly on the CURRENT
/// diff, plus the `body` carrying the original summary followed by any (sanitized) demoted
/// findings and a head note. Hand straight to [`super::post::post_review_with`].
pub(super) struct PreparedReview {
    pub comments: Vec<InlineComment>,
    pub body: String,
}

/// Make a review post SURVIVE GitHub's all-or-nothing anchor validation: partition
/// `comments` into those that anchor on the CURRENT `diff` vs. those that don't, keep only
/// the anchorable ones inline, DEMOTE the rest into `body` as a SANITIZED text section (no
/// finding is dropped, no out-of-diff anchor is left to 422 the whole post), and prepend a
/// head note comparing `reviewed_head` (the head the review saw) with `current_head` (the
/// head the diff reflects). Pure — the caller fetched `diff` + `current_head` via the `gh`
/// seam.
///
/// Guarantee: re-anchoring against the freshly-fetched `diff` means no comment posts
/// outside the current diff (never a 422). It does NOT guarantee a kept anchor still points
/// at the same code after a head move — the head note is the honesty signal for that.
pub(super) fn prepare_survivable_review(
    body: &str,
    comments: &[InlineComment],
    diff: &str,
    reviewed_head: Option<&str>,
    current_head: &str,
) -> PreparedReview {
    let valid = parse_valid_anchors(diff);
    let (anchorable, demoted) = partition_comments(comments, &valid);
    let head = head_status(reviewed_head, current_head);
    let body = compose_body(body, &demoted, &head);
    PreparedReview {
        comments: anchorable,
        body,
    }
}

/// Parse a PR's unified diff into the valid RIGHT-side inline-anchor line numbers per
/// changed file: for each file, the 1-based NEW-file line numbers that appear in a hunk
/// as a context (` `) or added (`+`) line — exactly the lines GitHub accepts for a
/// default-side (`RIGHT`) inline review comment. Removed (`-`) lines are LEFT-side only
/// and never included; deleted files (`+++ /dev/null`) contribute no anchors. Under-
/// approximating (a rename we can't map, a C-quoted path) merely demotes a comment to the
/// body — the safe direction — never a false anchor that would 422.
pub(super) fn parse_valid_anchors(diff: &str) -> HashMap<String, HashSet<u64>> {
    let mut anchors: HashMap<String, HashSet<u64>> = HashMap::new();
    let mut current_path: Option<String> = None;
    let mut new_line: u64 = 0;
    let mut in_hunk = false;

    for line in diff.lines() {
        // A new file section resets the path + hunk state (`diff --git a/… b/…`).
        if line.starts_with("diff --git ") {
            current_path = None;
            in_hunk = false;
            continue;
        }
        // A hunk header (`@@ -a,b +c,d @@ …`) — a column-0 `@@ ` is unambiguous (hunk-body
        // lines are always prefixed by a space/`+`/`-`). Parse the new-side start.
        if let Some(start) = parse_hunk_new_start(line) {
            new_line = start;
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            // File-header region: capture the new path from `+++ b/<path>` (or clear it on
            // `+++ /dev/null`, a deletion — no RIGHT-side anchors). The `--- …` + index /
            // mode / rename lines are ignored.
            if let Some(rest) = line.strip_prefix("+++ ") {
                current_path = parse_new_path(rest);
            }
            continue;
        }
        // Hunk body: advance the new-side counter and record the anchorable lines.
        match line.as_bytes().first().copied() {
            // Added or context line: anchorable on the RIGHT side; advances the new side.
            Some(b'+') | Some(b' ') | None => {
                if let Some(path) = &current_path {
                    anchors.entry(path.clone()).or_default().insert(new_line);
                }
                new_line += 1;
            }
            // A removed line is LEFT-side only: no anchor, no new-side advance.
            Some(b'-') => {}
            // `\ No newline at end of file` — metadata, not a line.
            Some(b'\\') => {}
            // Anything else inside a hunk is anomalous; ignore it defensively.
            Some(_) => {}
        }
    }
    anchors
}

/// Parse a unified-diff hunk header (`@@ -oldStart[,oldCount] +newStart[,newCount] @@ …`)
/// and return `newStart` — the 1-based first NEW-file line the hunk covers. `None` for a
/// non-hunk line so the caller falls through. Only a column-0 `@@ ` is a header (hunk-body
/// lines are always prefixed), so this never misfires on content.
fn parse_hunk_new_start(line: &str) -> Option<u64> {
    let rest = line.strip_prefix("@@ ")?;
    // rest = "-a,b +c,d @@ …" — find the `+` group and read its start before any `,`.
    let plus = rest.split_whitespace().find(|tok| tok.starts_with('+'))?;
    plus[1..].split(',').next()?.parse::<u64>().ok()
}

/// Extract the repo-relative new-file path from a `+++ ` header value: strip the git `b/`
/// prefix, cut any trailing tab metadata, and map `/dev/null` (a deletion) to `None` (no
/// RIGHT-side anchors). NOT a general git-quote decoder — a C-quoted path (rare:
/// non-ASCII / space names) simply won't match our finding's path and its comments demote
/// to the body, which is the safe direction.
fn parse_new_path(rest: &str) -> Option<String> {
    let raw = rest.split('\t').next().unwrap_or(rest).trim();
    if raw == "/dev/null" {
        return None;
    }
    let path = raw.strip_prefix("b/").unwrap_or(raw);
    (!path.is_empty()).then(|| path.to_string())
}

/// Split `comments` into `(anchorable, demoted)`: a comment is anchorable when its file is
/// in the diff AND its `line` is a valid RIGHT-side anchor there. Order-preserving; every
/// input lands in exactly one bucket (nothing dropped).
fn partition_comments(
    comments: &[InlineComment],
    valid: &HashMap<String, HashSet<u64>>,
) -> (Vec<InlineComment>, Vec<InlineComment>) {
    let mut anchorable = Vec::new();
    let mut demoted = Vec::new();
    for c in comments {
        if valid
            .get(&c.path)
            .is_some_and(|lines| lines.contains(&c.line))
        {
            anchorable.push(c.clone());
        } else {
            demoted.push(c.clone());
        }
    }
    (anchorable, demoted)
}

/// Classify the head the review saw vs. the head the current diff reflects. `Unverified`
/// when either is unknown/empty (a run with no captured head, or an unreadable current
/// head) — that case is SURFACED as a note, never silently dropped.
fn head_status(reviewed_head: Option<&str>, current_head: &str) -> HeadStatus {
    let reviewed = reviewed_head.map(str::trim).filter(|s| !s.is_empty());
    let current = Some(current_head.trim()).filter(|s| !s.is_empty());
    match (reviewed, current) {
        (Some(r), Some(c)) if r == c => HeadStatus::Current,
        (Some(r), Some(c)) => HeadStatus::Moved {
            reviewed: r.to_string(),
            current: c.to_string(),
        },
        _ => HeadStatus::Unverified,
    }
}

/// Compose the posted review body: the original summary, then (unless the head is verified
/// current) a head note, then (when any finding was demoted) a "couldn't be anchored
/// inline" section listing `path:line — message` for each. Untrusted `path` + `body` are
/// [`sanitize_untrusted_md`]'d before embedding; only sanitized finding text + line refs +
/// the two head SHAs are emitted. Returns `body` unchanged when nothing was demoted and the
/// head is verified current.
fn compose_body(body: &str, demoted: &[InlineComment], head: &HeadStatus) -> String {
    let note = head_note(head);
    if demoted.is_empty() && note.is_none() {
        return body.to_string();
    }
    let mut out = body.trim_end().to_string();
    if let Some(note) = note {
        out.push_str("\n\n---\n\n");
        out.push_str(&note);
    }
    if !demoted.is_empty() {
        out.push_str("\n\n---\n\n");
        out.push_str(
            "**Findings that couldn't be anchored inline**\n\n\
             These reference lines that are not part of the PR's current diff (the code \
             moved, or the line is outside a changed hunk), so they're listed here rather \
             than dropped:\n",
        );
        for c in demoted {
            out.push_str(&format!(
                "\n- `{}:{}` — {}",
                sanitize_untrusted_md(&c.path),
                c.line,
                sanitize_untrusted_md(&c.body),
            ));
        }
    }
    out
}

/// The honest head note for a [`HeadStatus`], or `None` when the head is verified current.
/// Both non-current cases state the real guarantee (no comment posts outside the diff) AND
/// its limit (an inline placement may not point at the same code the review read).
fn head_note(head: &HeadStatus) -> Option<String> {
    match head {
        HeadStatus::Current => None,
        HeadStatus::Moved { reviewed, current } => Some(format!(
            "> **Note — the PR head advanced since this review was computed** (reviewed \
             `{}`, now `{}`). Anchors were re-validated against the current diff, so no \
             comment posts outside it — but an inline comment may land on a valid line that \
             no longer points at the same code; treat inline placements as approximate.",
            short_sha(reviewed),
            short_sha(current),
        )),
        HeadStatus::Unverified => Some(
            "> **Note — the reviewed commit couldn't be verified** (this run recorded no \
             head SHA, or the current head was unreadable). Anchors were re-validated \
             against the current diff, so no comment posts outside it — but an inline \
             placement may not point at the same code the review read."
                .to_string(),
        ),
    }
}

/// A short, display-friendly commit SHA (first 12 chars) for the head note. The input is a
/// GitHub-provided hex OID (never attacker text), so this is presentation-only.
fn short_sha(sha: &str) -> String {
    sha.chars().take(12).collect()
}

/// Neutralize UNTRUSTED text — a finding's `file` (path chosen by the PR author) or `body`
/// (model prose derived from reading the untrusted diff) — for safe embedding as INLINE
/// markdown in a review body posted under the reviewing user's own GitHub identity. The
/// demote section is composed AFTER the human approval gate, so this text must be inert.
/// In one pass it:
/// - collapses ALL whitespace runs (incl. newlines) to a single space, so a finding stays
///   on its one list line and can't inject blank-line / block breaks;
/// - removes backticks — the only way to open/breakout of a code span;
/// - removes `<` `>` — raw HTML and `<url>` autolinks;
/// - removes `[` `]` — the text side of `[label](url)` links and `![alt](url)` images
///   (dropping the brackets defeats both, without mangling ordinary parentheses in prose);
/// - replaces `@` → `(at)` and `#` → `(hash)` — the sigils that fire user/team mentions and
///   issue refs (each a live notification);
/// - breaks the `://` scheme separator a bare-URL autolink needs (`http://x` → `http:x`).
///
/// The result is safe as plain prose; the path is additionally wrapped in a code span by
/// the caller (and, having no backticks, cannot break out of it).
pub(super) fn sanitize_untrusted_md(s: &str) -> String {
    let mapped: String = s
        // Break the scheme separator first so it can't be reconstructed after char removal.
        .replace("://", ":")
        .chars()
        .map(|c| match c {
            '`' | '<' | '>' | '[' | ']' => String::new(),
            '@' => "(at)".to_string(),
            '#' => "(hash)".to_string(),
            other => other.to_string(),
        })
        .collect();
    // Collapse every whitespace run (including the newlines we just want gone) to a space.
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}
