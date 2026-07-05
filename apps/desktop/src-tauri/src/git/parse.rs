//! Pure git porcelain output parsers — no I/O, no process spawning.
//!
//! Consolidated here so the crate's git consumers (the worktree diff/status
//! readers, the verification gates, the analysis readers) parse `git` porcelain
//! the SAME way instead of re-implementing the split/parse at each call site.
//! Every function is a pure `&str -> value` transform, unit-tested in this file.

/// One row of `git diff --numstat` output: additions, deletions, and the path.
/// Binary rows (`-\t-\tpath`) parse as `0/0`. `u64` so a large aggregate (summed
/// across every file in a diff budget) can't overflow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NumstatRow {
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) path: String,
}

/// Parse `git diff --numstat` output (run with `--no-renames`, so one path per
/// row) into per-file rows. A binary row (`-\t-\tpath`) contributes `0/0`; a row
/// without a path (blank / malformed) is skipped.
pub(crate) fn parse_numstat(out: &str) -> Vec<NumstatRow> {
    out.lines().filter_map(parse_numstat_line).collect()
}

/// Parse one `--numstat` row into a [`NumstatRow`], or `None` when the row has no
/// path. The add/del columns are `-` for binary files (parse → `0`).
fn parse_numstat_line(line: &str) -> Option<NumstatRow> {
    let mut f = line.splitn(3, '\t');
    let additions = f.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
    let deletions = f.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
    let path = f.next().map(str::to_string).filter(|p| !p.is_empty())?;
    Some(NumstatRow {
        additions,
        deletions,
        path,
    })
}

/// Parse `git rev-list --left-right --count <base>...HEAD` output
/// (`"<behind>\t<ahead>"`) into `(behind, ahead)`: the left count is commits
/// reachable from `base` but not HEAD (behind), the right is HEAD-only (ahead).
/// `None` on malformed output.
pub(crate) fn parse_left_right_count(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split_whitespace();
    let behind = parts.next()?.parse::<u32>().ok()?;
    let ahead = parts.next()?.parse::<u32>().ok()?;
    Some((behind, ahead))
}

/// Split `git ls-files -z` (NUL-delimited) output into its non-empty entries.
/// The `-z` form is NUL-delimited precisely so paths containing spaces or
/// newlines stay intact — split on `\0`, never on lines. Borrows from `out`.
pub(crate) fn parse_ls_files_z(out: &str) -> Vec<&str> {
    out.split('\0').filter(|p| !p.is_empty()).collect()
}

/// The changed entries of `git status --porcelain` output — one per staged /
/// unstaged / untracked path. An empty result means a clean tree. `git status
/// --porcelain` never emits blank lines, so filtering empties is equivalent to
/// counting lines while staying robust to a trailing newline. Borrows from `out`.
pub(crate) fn parse_status_porcelain(out: &str) -> Vec<&str> {
    out.lines().filter(|l| !l.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_parses_text_binary_and_skips_pathless_rows() {
        let rows = parse_numstat("10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\tassets/logo.png\n");
        assert_eq!(
            rows,
            vec![
                NumstatRow {
                    additions: 10,
                    deletions: 2,
                    path: "src/a.ts".to_string()
                },
                NumstatRow {
                    additions: 0,
                    deletions: 5,
                    path: "src/b.ts".to_string()
                },
                // The binary row (`-\t-\tpath`) contributes 0/0 but still a file.
                NumstatRow {
                    additions: 0,
                    deletions: 0,
                    path: "assets/logo.png".to_string()
                },
            ]
        );
        // Empty input → no rows; a row without a path (malformed) is dropped.
        assert!(parse_numstat("").is_empty());
        assert!(parse_numstat("5\t5\n").is_empty());
    }

    #[test]
    fn left_right_count_reads_behind_then_ahead() {
        assert_eq!(parse_left_right_count("3\t5"), Some((3, 5)));
        assert_eq!(parse_left_right_count("0 0"), Some((0, 0)));
        assert_eq!(parse_left_right_count(""), None);
        assert_eq!(parse_left_right_count("nope"), None);
    }

    #[test]
    fn ls_files_z_splits_on_nul_and_drops_empties() {
        assert_eq!(
            parse_ls_files_z("a.ts\0dir/b tsx\0c\n.ts\0"),
            vec!["a.ts", "dir/b tsx", "c\n.ts"],
            "splits on NUL (not lines/spaces) and drops the trailing empty"
        );
        assert!(parse_ls_files_z("").is_empty());
    }

    #[test]
    fn status_porcelain_counts_changed_entries() {
        assert_eq!(
            parse_status_porcelain(" M src/a.ts\n?? new.ts"),
            vec![" M src/a.ts", "?? new.ts"]
        );
        assert!(
            parse_status_porcelain("").is_empty(),
            "empty porcelain ⇒ clean tree"
        );
    }
}
