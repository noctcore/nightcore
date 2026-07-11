//! The scan-kind axis: the three export targets (Insight / Scorecard / Enforce),
//! their wire strings, display names, item nouns, and per-kind `nc:*` label.

use crate::workflow::github_labels::{Label, NC_ENFORCE, NC_INSIGHT, NC_SCORECARD};

/// One of the three codebase-scan export targets (decision 1). PR Review + Issue
/// Triage are excluded — their output already lives on GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanKind {
    Insight,
    Scorecard,
    Enforce,
}

impl ScanKind {
    /// Parse the wire string the command receives; an unknown value is a hard error
    /// (never a silent default that would export the wrong store).
    pub(crate) fn from_wire(s: &str) -> Result<Self, String> {
        match s {
            "insight" => Ok(Self::Insight),
            "scorecard" => Ok(Self::Scorecard),
            "enforce" => Ok(Self::Enforce),
            other => Err(format!(
                "unknown scan kind `{other}` (expected insight | scorecard | enforce)"
            )),
        }
    }

    /// The wire string (mirrors [`from_wire`]).
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Insight => "insight",
            Self::Scorecard => "scorecard",
            Self::Enforce => "enforce",
        }
    }

    /// The human display name for titles/headers ("Insight" / "Scorecard" / "Enforce").
    pub(crate) fn display(self) -> &'static str {
        match self {
            Self::Insight => "Insight",
            Self::Scorecard => "Scorecard",
            Self::Enforce => "Enforce",
        }
    }

    /// The item noun (singular / plural) for the deterministic parent title + counts.
    pub(crate) fn noun(self, count: u32) -> &'static str {
        let one = count == 1;
        match self {
            Self::Insight => {
                if one {
                    "finding"
                } else {
                    "findings"
                }
            }
            Self::Scorecard => {
                if one {
                    "reading"
                } else {
                    "readings"
                }
            }
            Self::Enforce => {
                if one {
                    "convention"
                } else {
                    "conventions"
                }
            }
        }
    }

    /// The per-scan-kind `nc:*` label — also the supersede-discovery key (§3.10).
    pub(crate) fn label(self) -> Label {
        match self {
            Self::Insight => NC_INSIGHT,
            Self::Scorecard => NC_SCORECARD,
            Self::Enforce => NC_ENFORCE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_round_trips_and_rejects_unknown() {
        for k in [ScanKind::Insight, ScanKind::Scorecard, ScanKind::Enforce] {
            assert_eq!(ScanKind::from_wire(k.wire()).unwrap(), k);
        }
        assert!(ScanKind::from_wire("pr-review").is_err());
    }

    #[test]
    fn noun_pluralizes_on_count() {
        assert_eq!(ScanKind::Insight.noun(1), "finding");
        assert_eq!(ScanKind::Insight.noun(2), "findings");
        assert_eq!(ScanKind::Enforce.noun(1), "convention");
    }

    #[test]
    fn label_matches_the_kind() {
        assert_eq!(ScanKind::Insight.label().suffix, "insight");
        assert_eq!(ScanKind::Scorecard.label().suffix, "scorecard");
        assert_eq!(ScanKind::Enforce.label().suffix, "enforce");
        // Composed under the default prefix, they read as the historical `nc:*` names.
        assert_eq!(ScanKind::Insight.label().full_name("nc:"), "nc:insight");
    }
}
