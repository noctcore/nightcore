//! Pure parsing of `gh` output: the created-PR URL/number from `gh pr create`
//! stdout, and the OPEN-PR recovery view from `gh pr view --json`.

/// Parse `gh pr view --json url,number,state` output into `(url, number)`,
/// accepting only an OPEN PR (a closed/merged PR for the branch must not be
/// resurrected as "the" created PR) with an https URL. Pure.
pub(super) fn parse_pr_view(stdout: &str) -> Option<(String, u64)> {
    #[derive(serde::Deserialize)]
    struct View {
        url: String,
        number: u64,
        state: String,
    }
    let view: View = serde_json::from_str(stdout.trim()).ok()?;
    if view.state != "OPEN" || !view.url.starts_with("https://") {
        return None;
    }
    Some((view.url, view.number))
}

/// Parse the created PR's URL + number from `gh pr create` stdout. By contract
/// gh prints the URL as the trailing line (`https://…/pull/<n>`); scan from the
/// end for the first line that parses, tolerating trailing blank lines and any
/// leading chatter. Pure.
pub(super) fn parse_pr_url(stdout: &str) -> Option<(String, u64)> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find_map(|line| {
            if !line.starts_with("https://") {
                return None;
            }
            let number = pr_number_from_url(line)?;
            Some((line.to_string(), number))
        })
}

/// The PR number from a URL shaped `https://…/pull/<n>` (tolerating a trailing
/// slash). `None` when the shape doesn't match. Pure.
fn pr_number_from_url(url: &str) -> Option<u64> {
    let (_, tail) = url.rsplit_once("/pull/")?;
    tail.trim_end_matches('/').parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pr_url_reads_the_trailing_line() {
        // The clean contract shape: the URL is the last line.
        assert_eq!(
            parse_pr_url("https://github.com/acme/widget/pull/123\n"),
            Some(("https://github.com/acme/widget/pull/123".to_string(), 123))
        );
        // gh may print chatter first (e.g. "Creating pull request for … into …").
        let noisy = "Creating pull request for nc/t-1 into main in acme/widget\n\n\
                     https://github.com/acme/widget/pull/7\n\n";
        assert_eq!(
            parse_pr_url(noisy),
            Some(("https://github.com/acme/widget/pull/7".to_string(), 7))
        );
        // A trailing slash still parses; GHES-style hosts too.
        assert_eq!(
            parse_pr_url("https://git.corp.example/o/r/pull/42/"),
            Some(("https://git.corp.example/o/r/pull/42/".to_string(), 42))
        );
        // No URL, a non-https line, or an unparseable number ⇒ None.
        assert_eq!(parse_pr_url("nothing here"), None);
        assert_eq!(parse_pr_url("http://github.com/acme/widget/pull/1"), None);
        assert_eq!(
            parse_pr_url("https://github.com/acme/widget/pull/abc"),
            None
        );
        assert_eq!(parse_pr_url(""), None);
    }

    #[test]
    fn pr_number_from_url_parses_the_tail() {
        assert_eq!(pr_number_from_url("https://github.com/a/b/pull/9"), Some(9));
        assert_eq!(
            pr_number_from_url("https://github.com/a/b/pull/9/"),
            Some(9)
        );
        assert_eq!(pr_number_from_url("https://github.com/a/b/issues/9"), None);
        assert_eq!(pr_number_from_url("https://github.com/a/b/pull/"), None);
    }

    #[test]
    fn parse_pr_view_accepts_only_open_https_prs() {
        assert_eq!(
            parse_pr_view(r#"{"url":"https://github.com/a/b/pull/7","number":7,"state":"OPEN"}"#),
            Some(("https://github.com/a/b/pull/7".to_string(), 7))
        );
        // A closed/merged PR must not be resurrected as "the" created PR.
        for state in ["CLOSED", "MERGED"] {
            assert_eq!(
                parse_pr_view(&format!(
                    r#"{{"url":"https://github.com/a/b/pull/7","number":7,"state":"{state}"}}"#
                )),
                None,
                "{state} is not recoverable"
            );
        }
        // Non-https URLs and garbage are rejected.
        assert_eq!(
            parse_pr_view(r#"{"url":"http://github.com/a/b/pull/7","number":7,"state":"OPEN"}"#),
            None
        );
        assert_eq!(parse_pr_view("not json"), None);
        assert_eq!(parse_pr_view(""), None);
    }
}
