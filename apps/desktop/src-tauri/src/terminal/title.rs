//! The tab-title precedence source (build spec — terminal round 2, PR A).
//!
//! A terminal tab's title is a single `Option<String>`, but it can be set by three
//! different actors that must NOT clobber each other: a **manual** inline rename, a
//! **task** auto-take (a task linked into the shell), and an **AI** auto-name (the
//! opt-in `claude -p` haiku suggestion). This module carries the one new invariant
//! that keeps them ordered:
//!
//! > A title write lands only if it out-ranks-or-ties the current source. Ranks are
//! > **Manual (4) > Task (3) > Auto (2) > ProcessTitle (1) > Unset (0)**. So the shell
//! > process-title (OSC 0/2) is a better default than the cwd leaf but yields to an AI
//! > name, a task title, and a manual rename; an AI (`Auto`) name never overwrites a
//! > human or task title; a task title never overwrites a manual one; and a manual
//! > rename always wins.
//!
//! **Legacy-safety:** a session titled BEFORE this feature has a `title` string but
//! `source == None`. A non-empty untracked title is treated as **Manual-equivalent**
//! (rank 3), so the AI never renames a shell the user hand-named in an older build.

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

/// Where a tab's current title came from — the precedence source. Serializes
/// camelCase to the TS union `"manual" | "task" | "auto" | "processTitle"`; the wire
/// field is `Option<TitleSource>` (a legacy / never-titled session is `None`, treated
/// as `Unset` unless it carries a non-empty title, § module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TitleSource.ts"))]
pub enum TitleSource {
    /// A manual inline rename — always wins and locks the title.
    Manual,
    /// A linked task's auto-taken title — wins over AI, loses to Manual.
    Task,
    /// An AI (haiku) auto-name — refused over Manual/Task, wins over ProcessTitle.
    Auto,
    /// The shell's own process-title escape (OSC 0/2) — the LOWEST-ranked writer (T11):
    /// a better default than the cwd leaf, but yields to every deliberate name (Auto,
    /// Task, Manual). It only ever fills in an Unset session or replaces a prior
    /// process-title, so a `claude`/`vim` window title never clobbers a chosen name.
    ProcessTitle,
}

impl TitleSource {
    /// The precedence rank (higher wins). `Unset` has no variant — it is the `None`
    /// source, whose rank is computed contextually by [`TitleState::effective_rank`].
    const fn rank(self) -> u8 {
        match self {
            TitleSource::Manual => 4,
            TitleSource::Task => 3,
            TitleSource::Auto => 2,
            TitleSource::ProcessTitle => 1,
        }
    }
}

/// Whether an AUTO (AI) write is eligible for a descriptor with the given `title` +
/// `source`: only when the effective source is `Auto` or `Unset` — never `Manual` /
/// `Task`, and never a legacy non-empty-title-with-no-source (Manual-equivalent). The
/// command layer uses this as a server-side pre-check before it even spawns `claude`.
pub(crate) fn auto_eligible(title: Option<&str>, source: Option<TitleSource>) -> bool {
    match source {
        Some(TitleSource::Auto) => true,
        Some(_) => false,
        // Legacy / never-set: eligible only when there is no pre-existing title.
        None => title.map_or(true, str::is_empty),
    }
}

/// The live title + its recorded source, guarded together (behind the session's
/// `Mutex`) so a precedence decision is atomic — a manual rename that lands during
/// the ~2s AI generation still wins, because the guarded [`apply`](Self::apply) reads
/// and writes both under one lock.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TitleState {
    /// The current title (`None` / empty ⇒ the web labels by the cwd leaf).
    pub(crate) title: Option<String>,
    /// The source that last wrote `title`, or `None` for a legacy / never-set title.
    pub(crate) source: Option<TitleSource>,
}

impl TitleState {
    /// The current precedence rank, applying the legacy-safety rule: a `None` source
    /// with a non-empty title ranks as Manual (3); a `None` source with an empty /
    /// absent title is Unset (0).
    fn effective_rank(&self) -> u8 {
        match self.source {
            Some(s) => s.rank(),
            None => {
                if self.title.as_deref().is_some_and(|t| !t.is_empty()) {
                    TitleSource::Manual.rank()
                } else {
                    0
                }
            }
        }
    }

    /// Whether an AUTO write would be eligible against the current state (§
    /// [`auto_eligible`]). Test-only ergonomics — production checks eligibility on the
    /// wire descriptor via the free [`auto_eligible`], not on a live `TitleState`.
    #[cfg(test)]
    pub(crate) fn auto_eligible(&self) -> bool {
        auto_eligible(self.title.as_deref(), self.source)
    }

    /// Apply a title write carrying `source`, honoring precedence: it lands only if
    /// its rank out-ranks-or-ties the current effective rank. Returns whether it
    /// landed (a refused write leaves the state untouched).
    pub(crate) fn apply(&mut self, title: Option<String>, source: TitleSource) -> bool {
        if source.rank() < self.effective_rank() {
            return false;
        }
        self.title = title;
        self.source = Some(source);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_always_wins_and_locks() {
        let mut s = TitleState::default();
        assert!(s.apply(Some("deploy".into()), TitleSource::Manual));
        assert_eq!(s.source, Some(TitleSource::Manual));
        // Task and Auto are both refused over Manual.
        assert!(!s.apply(Some("task title".into()), TitleSource::Task));
        assert!(!s.apply(Some("ai title".into()), TitleSource::Auto));
        assert_eq!(s.title.as_deref(), Some("deploy"));
    }

    #[test]
    fn task_beats_auto_but_loses_to_manual() {
        let mut s = TitleState::default();
        assert!(s.apply(Some("build web".into()), TitleSource::Auto));
        // Task out-ranks the AI name.
        assert!(s.apply(Some("dark mode".into()), TitleSource::Task));
        assert_eq!(s.source, Some(TitleSource::Task));
        // A later AI name cannot clobber the task title.
        assert!(!s.apply(Some("run tests".into()), TitleSource::Auto));
        assert_eq!(s.title.as_deref(), Some("dark mode"));
    }

    #[test]
    fn auto_names_an_unset_session_and_may_re_auto() {
        let mut s = TitleState::default();
        assert!(s.auto_eligible(), "a fresh session is AI-eligible");
        assert!(s.apply(Some("build web".into()), TitleSource::Auto));
        // Still Auto-sourced, so a new command can re-suggest.
        assert!(s.auto_eligible());
        assert!(s.apply(Some("start server".into()), TitleSource::Auto));
        assert_eq!(s.title.as_deref(), Some("start server"));
    }

    #[test]
    fn process_title_fills_unset_but_yields_to_every_deliberate_name() {
        // A fresh (Unset) session takes the shell's process-title as a better default.
        let mut s = TitleState::default();
        assert!(s.apply(Some("~/dev/app".into()), TitleSource::ProcessTitle));
        assert_eq!(s.source, Some(TitleSource::ProcessTitle));
        // A newer process-title replaces the prior one (ties at rank 1).
        assert!(s.apply(Some("npm run dev".into()), TitleSource::ProcessTitle));
        assert_eq!(s.title.as_deref(), Some("npm run dev"));

        // An AI name out-ranks the process-title and takes over.
        assert!(s.apply(Some("dev server".into()), TitleSource::Auto));
        // The process-title can no longer clobber the AI (or a Task/Manual) name.
        assert!(!s.apply(Some("node".into()), TitleSource::ProcessTitle));
        assert_eq!(s.title.as_deref(), Some("dev server"));

        // A manual rename locks it against the process-title too.
        let mut m = TitleState::default();
        assert!(m.apply(Some("deploy".into()), TitleSource::Manual));
        assert!(!m.apply(Some("bash".into()), TitleSource::ProcessTitle));
        assert_eq!(m.title.as_deref(), Some("deploy"));
    }

    #[test]
    fn a_legacy_untracked_title_is_treated_as_manual() {
        // A session titled before this feature: title present, source None. The AI
        // must NOT rename it (the load-bearing legacy-safety case).
        let s = TitleState {
            title: Some("my shell".into()),
            source: None,
        };
        assert!(
            !s.auto_eligible(),
            "a pre-existing untracked title is locked"
        );
        assert_eq!(s.effective_rank(), TitleSource::Manual.rank());

        // But a legacy record with an EMPTY title is Unset → eligible.
        let empty = TitleState {
            title: Some(String::new()),
            source: None,
        };
        assert!(empty.auto_eligible());
        assert!(auto_eligible(None, None), "no title, no source ⇒ eligible");
    }

    #[test]
    fn manual_out_ranks_a_legacy_title_and_relands() {
        // A manual rename over a legacy title lands (rank ties at 3) and records the
        // source, so it is no longer "untracked".
        let mut s = TitleState {
            title: Some("old".into()),
            source: None,
        };
        assert!(s.apply(Some("new".into()), TitleSource::Manual));
        assert_eq!(s.source, Some(TitleSource::Manual));
    }
}
