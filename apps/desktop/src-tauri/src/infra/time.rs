//! Dependency-free civil-time formatting shared across tiers.
//!
//! The crate deliberately avoids a date dependency (`chrono`), so ISO-8601 UTC
//! formatting is pure integer arithmetic (Howard Hinnant's `civil_from_days`).
//! Lifted here (rank 1) from `workflow::trust::aggregate` (issue #121, the usage
//! meter) so both the Trust Report's `generated_at` AND the usage poller's Codex
//! reset timestamps can format an epoch instant without either tier reaching
//! sideways or a leaf depending upward.

/// Format an epoch-millis instant as ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) without
/// a date crate. Pure civil-time arithmetic — deterministic and unit-tested against
/// known instants.
pub(crate) fn iso8601_utc(epoch_ms: u64) -> String {
    let secs = (epoch_ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Format an epoch-SECONDS instant as ISO-8601 UTC. A convenience for the many
/// unix-second reset fields the usage endpoints return (Codex `reset_at`); negative
/// (pre-epoch, never a real reset) inputs yield `None` rather than a bogus date.
pub(crate) fn iso8601_utc_from_secs(epoch_secs: i64) -> Option<String> {
    if epoch_secs < 0 {
        return None;
    }
    Some(iso8601_utc((epoch_secs as u64).saturating_mul(1000)))
}

/// (year, month `1..=12`, day `1..=31`) for a count of days since 1970-01-01
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_utc_formats_a_known_instant() {
        // 1_700_000_000_000 ms = 2023-11-14T22:13:20Z (the Trust Report anchor).
        assert_eq!(iso8601_utc(1_700_000_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn iso8601_from_secs_matches_the_millis_path_and_guards_negatives() {
        // 1_700_000_000 s is the same instant as the millis case above.
        assert_eq!(
            iso8601_utc_from_secs(1_700_000_000).as_deref(),
            Some("2023-11-14T22:13:20Z")
        );
        assert_eq!(
            iso8601_utc_from_secs(0).as_deref(),
            Some("1970-01-01T00:00:00Z")
        );
        // A negative (pre-epoch) reset is never a real value — degrade to None.
        assert_eq!(iso8601_utc_from_secs(-1), None);
    }
}
