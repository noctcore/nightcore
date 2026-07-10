//! Shared GitHub-safe markdown helpers — the neutral home for the fence/sanitize
//! primitives that keep repo/agent-derived text from breaking out of (or forging)
//! its rendering context when a Nightcore body lands on GitHub.
//!
//! Lifted here from `workflow/trust/render.rs` (PR #113, §10.5 of the issue-map
//! spec): the Trust Report renderer and the issue-map renderer BOTH need the same
//! `code_span`/`longest_backtick_run`/`sanitize_label`/`one_line` primitives, so
//! they live in one neutral peer instead of being duplicated or coupling
//! `issue_map` into `trust`. The trust renderer now imports them from here; the
//! extraction is behavior-preserving (verified by the existing `workflow::trust`
//! tests).
//!
//! UNTRUSTED-CONTENT RULE (§3.6): every untrusted span (a path, a command, a
//! finding title) is rendered via [`code_span`] — control chars → spaces +
//! whitespace collapsed (the `sanitize_minted_title` idiom) then fenced with a
//! backtick run strictly longer than any run inside it (the `defuse_fence` idea)
//! so nothing can break out of its code span. Multi-line untrusted code goes
//! through [`code_block`]; untrusted prose (a description/rationale) through
//! [`prose`]. The prompt-only `untrusted_block` (`infra::untrusted`) is
//! deliberately NOT used on a GitHub body — it frames text INTO an agent and
//! renders as noise in a markdown body.

/// Render an UNTRUSTED string as a single GitHub-safe inline code span: control
/// chars → spaces + whitespace collapsed (the `sanitize_minted_title` idiom, which
/// also caps + never returns empty), then fenced with a backtick run strictly
/// longer than any run inside the content (the `defuse_fence` idea) so a crafted
/// span cannot break out. CommonMark strips one leading + trailing space when both
/// are present, so pad when the content abuts a backtick.
pub(crate) fn code_span(raw: &str) -> String {
    let clean = crate::task::sanitize_minted_title(raw, "(empty)");
    let fence = "`".repeat(longest_backtick_run(&clean) + 1);
    if clean.starts_with('`') || clean.ends_with('`') {
        format!("{fence} {clean} {fence}")
    } else {
        format!("{fence}{clean}{fence}")
    }
}

/// The longest run of consecutive backticks in `s` (0 when none).
pub(crate) fn longest_backtick_run(s: &str) -> usize {
    let mut max = 0usize;
    let mut cur = 0usize;
    for ch in s.chars() {
        if ch == '`' {
            cur += 1;
            max = max.max(cur);
        } else {
            cur = 0;
        }
    }
    max
}

/// Collapse an untrusted label to one printable line (no fencing) — for spans
/// already inside our own backticks (a `kind`/`rule`), or for short prose lines
/// (a verdict/policy) that must not break the layout.
pub(crate) fn sanitize_label(raw: &str) -> String {
    crate::task::sanitize_minted_title(raw, "(none)")
}

/// A prose line collapsed to one printable line (control chars → spaces). Alias of
/// [`sanitize_label`] kept as a distinct name for the trust renderer's call sites.
pub(crate) fn one_line(raw: &str) -> String {
    crate::task::sanitize_minted_title(raw, "(none)")
}

/// Sanitize UNTRUSTED multi-line PROSE for a GitHub body: map every control char
/// EXCEPT newline to a space, collapse 3+ blank lines to a single blank line, and
/// trim. Unlike [`one_line`] this preserves the full text + paragraph breaks (a
/// finding description is multiple sentences, not a title), so it never truncates.
/// The remaining injection surface is markdown/HTML, which GitHub sanitizes
/// server-side; the backtick-escape defense that matters lives in [`code_span`] /
/// [`code_block`], which untrusted spans/code go through instead.
pub(crate) fn prose(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c == '\n' || !c.is_control() { c } else { ' ' })
        .collect();
    // Collapse 3+ consecutive newlines (a blank-line run) down to one blank line.
    let mut out = String::with_capacity(cleaned.len());
    let mut newlines = 0usize;
    for ch in cleaned.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push('\n');
            }
        } else {
            newlines = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// Render UNTRUSTED multi-line code as a GitHub-safe fenced block: strip control
/// chars except newline/tab, then wrap in a backtick fence strictly longer than any
/// run inside the content (and at least the CommonMark minimum of three) so the body
/// cannot terminate the fence early and inject markdown after it.
pub(crate) fn code_block(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .map(|c| {
            if c == '\n' || c == '\t' || !c.is_control() {
                c
            } else {
                ' '
            }
        })
        .collect();
    let fence = "`".repeat(longest_backtick_run(&clean).max(2) + 1);
    format!("{fence}\n{}\n{fence}", clean.trim_end_matches('\n'))
}

/// Truncate a rendered body to at most `cap` bytes at a UTF-8 char boundary,
/// appending a marker on overflow — the GitHub 64K issue-body guard against a
/// runaway finding (clone of the `SUMMARY_MAX_CHARS` idiom).
pub(crate) fn cap_body(mut body: String, cap: usize) -> String {
    if body.len() <= cap {
        return body;
    }
    let mut end = cap;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    body.truncate(end);
    body.push_str("\n\n_(truncated)_");
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_span_fences_plain_and_backtick_content() {
        assert_eq!(code_span("src/main.rs"), "`src/main.rs`");
        // A lone backtick needs a 2-backtick fence + padding so it can't break out.
        let span = code_span("`");
        assert!(span.starts_with("``") && span.ends_with("``"));
        assert_eq!(code_span("   "), "`(empty)`");
    }

    #[test]
    fn code_span_neutralizes_control_chars_and_newlines_into_one_span() {
        let hostile = "a`` `` b\nrm -rf /\u{1b}[31m";
        let span = code_span(hostile);
        assert!(!span.contains('\n'), "newlines collapsed");
        // The fence is strictly longer than the longest internal backtick run.
        let lead = span.chars().take_while(|&c| c == '`').count();
        let inner = &span[lead..span.len() - lead];
        assert!(
            longest_backtick_run(inner) < lead,
            "fence dominates content"
        );
    }

    #[test]
    fn prose_keeps_paragraphs_but_strips_control_chars() {
        let raw = "Line one\u{1b}[0m.\n\n\n\nLine two\ttabbed.";
        let out = prose(raw);
        assert!(!out.contains('\u{1b}'), "escape stripped");
        assert!(
            out.contains("Line one [0m."),
            "content preserved, esc→space"
        );
        assert!(
            out.contains("Line two tabbed."),
            "tab→space, content preserved"
        );
        assert!(
            out.contains("\n\n"),
            "a blank line between paragraphs survives"
        );
        assert!(!out.contains("\n\n\n"), "3+ blank lines collapse to one");
    }

    #[test]
    fn code_block_fence_dominates_internal_backticks() {
        let out = code_block("let a = 1;\n```\nnot-a-fence\n```");
        let fence_len = out.chars().take_while(|&c| c == '`').count();
        assert!(
            fence_len >= 4,
            "fence longer than the internal triple-backtick"
        );
        assert!(out.contains("not-a-fence"), "body preserved");
    }

    #[test]
    fn cap_body_truncates_on_a_char_boundary() {
        let big = "é".repeat(1000); // 2000 bytes
        let capped = cap_body(big, 101); // 101 is mid-`é` → backs off to 100
        assert!(capped.contains("_(truncated)_"));
        let content = capped.split("\n\n_(truncated)").next().unwrap();
        assert_eq!(content.chars().filter(|&c| c == 'é').count(), 50);
    }

    #[test]
    fn cap_body_is_a_noop_under_cap() {
        assert_eq!(cap_body("short".to_string(), 100), "short");
    }
}
