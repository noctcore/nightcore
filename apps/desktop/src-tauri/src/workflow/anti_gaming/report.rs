//! Evidence rendering: turn the collected [`Finding`]s into the check `output`
//! that `fix_instruction` hands the auto-fix agent — leading with the required
//! action, then naming every file/pattern (capped so a pathological diff can't
//! balloon the persisted task JSON).

use super::detect::Finding;

/// Cap on rendered evidence lines: enough for the auto-fix agent to act on, small
/// enough that a pathological diff can't balloon the persisted task JSON.
pub(super) const MAX_LISTED_FINDINGS: usize = 40;

/// Render the evidence list for the check `output` — this is what
/// `fix_instruction` hands the auto-fix agent, so it leads with the required
/// action and then names every file/pattern (capped, so a pathological diff
/// can't balloon the persisted task).
pub(super) fn render_evidence(findings: &[Finding]) -> String {
    let mut out = format!(
        "Anti-gaming sweep: {} suspicious change(s) in this build's diff. Undo each \
         one and make the checks pass legitimately — do NOT focus/skip tests, add \
         `@ts-ignore`/`eslint-disable` suppressions, remove assertions, or edit \
         gate config under .nightcore/ (use `@ts-expect-error` where a suppression \
         is genuinely warranted):\n",
        findings.len()
    );
    for f in findings.iter().take(MAX_LISTED_FINDINGS) {
        out.push_str("- ");
        out.push_str(&f.render());
        out.push('\n');
    }
    if findings.len() > MAX_LISTED_FINDINGS {
        out.push_str(&format!(
            "… and {} more\n",
            findings.len() - MAX_LISTED_FINDINGS
        ));
    }
    out.trim_end().to_string()
}
