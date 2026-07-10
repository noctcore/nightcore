//! The per-session scrollback ring + the output coalescer — both PURE (no PTY, no
//! Tauri, no threads) so they unit-test with a scripted clock.
//!
//! **Ring** ([`ScrollbackRing`]): a bounded raw-byte buffer of recent PTY output,
//! capped by BOTH a line count (~10k, the spec's ring size) AND a hard byte budget
//! (a TUI that never emits `\n` — a full-screen redraw — would otherwise grow one
//! unbounded "line"). Trimming drops whole lines from the front (at `\n`
//! boundaries) so a persisted replay starts on a line edge, then falls back to a
//! raw byte drop only to honor the hard byte cap. The bytes are the exact stream
//! xterm.js replays on restore (PR C), escape sequences and all.
//!
//! **Coalescer** ([`Coalescer`]): the batching stage between the blocking reader
//! and the binary `ipc::Channel`. Naive per-read emits are the documented Tauri
//! failure mode; this accumulates reads and flushes on a size cap (a full batch
//! rides Tauri's fast binary-fetch path) OR after a short delay since the first
//! pending byte (so an idle prompt still shows up). Time is injected (`now:
//! Instant`) so the flush boundary is deterministic in tests — the session thread
//! passes real `Instant::now()`.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Default scrollback line cap — the spec's "≈10k lines/session".
pub(crate) const DEFAULT_MAX_LINES: usize = 10_000;

/// Hard byte budget for the ring, independent of the line cap. A full-screen TUI
/// can emit megabytes with almost no `\n`; without this a single "line" would grow
/// without bound. 1 MiB is roughly omniscribe's service-side scrollback size.
pub(crate) const DEFAULT_MAX_BYTES: usize = 1024 * 1024;

/// A bounded raw-byte scrollback buffer. Not thread-safe by itself — the session
/// holds it behind a `Mutex` shared with the coalescer thread.
#[derive(Debug)]
pub(crate) struct ScrollbackRing {
    buf: VecDeque<u8>,
    /// Number of `\n` bytes currently in `buf` (tracked incrementally so `push`
    /// stays amortized-O(bytes) instead of rescanning the whole buffer).
    newlines: usize,
    max_lines: usize,
    max_bytes: usize,
}

impl ScrollbackRing {
    pub(crate) fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            buf: VecDeque::new(),
            newlines: 0,
            max_lines,
            max_bytes,
        }
    }

    /// The ring sized with the crate defaults (~10k lines / 1 MiB).
    pub(crate) fn with_defaults() -> Self {
        Self::new(DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
    }

    /// Append raw PTY bytes, then trim back under both caps.
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.buf.push_back(b);
            if b == b'\n' {
                self.newlines += 1;
            }
        }
        self.trim();
    }

    /// A copy of the current buffer contents (oldest → newest) — the bytes an
    /// xterm replays on restore, and what the persist path serializes.
    pub(crate) fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    /// Current byte length (for tests + the persist metadata).
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    fn trim(&mut self) {
        // A line's worth of bytes is everything up to and INCLUDING the next `\n`.
        // The ring holds at most `max_lines` COMPLETED lines plus the trailing
        // partial line, so trim while there are strictly more newlines than the cap.
        while self.newlines > self.max_lines {
            self.drop_front_line();
        }
        // Hard byte cap: drop from the front until under budget. Prefer a whole
        // line; if the front line is itself larger than the budget (a giant
        // no-newline TUI frame), fall back to dropping raw bytes.
        while self.buf.len() > self.max_bytes {
            if self.newlines > 0 {
                self.drop_front_line();
            } else {
                self.drop_front_bytes(self.buf.len() - self.max_bytes);
            }
        }
    }

    /// Pop bytes up to and including the first `\n` (or the whole buffer if there
    /// is none), keeping `newlines` in sync.
    fn drop_front_line(&mut self) {
        while let Some(b) = self.buf.pop_front() {
            if b == b'\n' {
                self.newlines -= 1;
                return;
            }
        }
    }

    /// Pop exactly `n` bytes from the front (used only when a single line already
    /// exceeds the byte budget), keeping `newlines` in sync.
    fn drop_front_bytes(&mut self, n: usize) {
        for _ in 0..n {
            match self.buf.pop_front() {
                Some(b'\n') => self.newlines -= 1,
                Some(_) => {}
                None => return,
            }
        }
    }
}

/// Flush thresholds for the [`Coalescer`]. Split out so the session thread and the
/// tests share one source of truth.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CoalesceConfig {
    /// Flush once pending reaches this many bytes (a full binary-path batch).
    pub(crate) max_batch: usize,
    /// Flush at most this long after the first pending byte, so an idle prompt is
    /// not held hostage waiting for `max_batch`.
    pub(crate) flush_after: Duration,
}

impl Default for CoalesceConfig {
    fn default() -> Self {
        Self {
            // 64 KiB max batch, ~8 ms latency window — the feasibility's
            // 32–64 KB / 4–16 ms band.
            max_batch: 64 * 1024,
            flush_after: Duration::from_millis(8),
        }
    }
}

/// Accumulates reader chunks and decides WHEN to emit a coalesced batch. Pure: the
/// caller feeds bytes + the current `Instant` and applies whatever batch comes
/// back. No I/O, no threads, no wall-clock reads inside.
#[derive(Debug)]
pub(crate) struct Coalescer {
    pending: Vec<u8>,
    /// When the first still-unflushed byte arrived (the flush-delay anchor).
    first_at: Option<Instant>,
    cfg: CoalesceConfig,
}

impl Coalescer {
    pub(crate) fn new(cfg: CoalesceConfig) -> Self {
        Self {
            pending: Vec::new(),
            first_at: None,
            cfg,
        }
    }

    /// Feed a reader chunk. Returns `Some(batch)` when the size cap trips (the
    /// batch is handed off and pending resets); otherwise the bytes stay pending
    /// for a later size/time flush.
    pub(crate) fn push(&mut self, chunk: &[u8], now: Instant) -> Option<Vec<u8>> {
        if chunk.is_empty() {
            return None;
        }
        if self.pending.is_empty() {
            self.first_at = Some(now);
        }
        self.pending.extend_from_slice(chunk);
        if self.pending.len() >= self.cfg.max_batch {
            return self.take();
        }
        None
    }

    /// The wall-clock deadline for the current pending batch, or `None` when there
    /// is nothing pending. The thread loop uses this to size its `recv_timeout`.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.first_at.map(|t| t + self.cfg.flush_after)
    }

    /// Time-driven flush: returns `Some(batch)` iff there is pending data AND
    /// `flush_after` has elapsed since the first pending byte.
    pub(crate) fn flush_due(&mut self, now: Instant) -> Option<Vec<u8>> {
        match self.first_at {
            Some(t) if now.duration_since(t) >= self.cfg.flush_after => self.take(),
            _ => None,
        }
    }

    /// Unconditionally drain whatever is pending (used on session exit / EOF so no
    /// trailing bytes are lost).
    pub(crate) fn drain(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            None
        } else {
            self.take()
        }
    }

    fn take(&mut self) -> Option<Vec<u8>> {
        self.first_at = None;
        Some(std::mem::take(&mut self.pending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_trims_to_the_line_cap_at_line_boundaries() {
        let mut ring = ScrollbackRing::new(3, DEFAULT_MAX_BYTES);
        for i in 0..6 {
            ring.push(format!("line{i}\n").as_bytes());
        }
        // Only the last 3 completed lines survive; trimming happened on `\n` edges.
        let out = String::from_utf8(ring.snapshot()).unwrap();
        assert_eq!(out, "line3\nline4\nline5\n");
    }

    #[test]
    fn ring_keeps_a_trailing_partial_line() {
        // A partial (no trailing `\n`) line is retained alongside the capped
        // completed lines — a prompt with no newline must still be in scrollback.
        let mut ring = ScrollbackRing::new(2, DEFAULT_MAX_BYTES);
        ring.push(b"a\nb\nc\n");
        ring.push(b"prompt$ ");
        let out = String::from_utf8(ring.snapshot()).unwrap();
        assert_eq!(out, "b\nc\nprompt$ ");
    }

    #[test]
    fn ring_enforces_the_hard_byte_cap_without_newlines() {
        // A flood with no newlines (a TUI redraw) must not grow past the byte cap.
        let mut ring = ScrollbackRing::new(DEFAULT_MAX_LINES, 16);
        ring.push(&[b'x'; 64]);
        assert!(ring.len() <= 16, "byte cap holds even with zero newlines");
    }

    #[test]
    fn coalescer_flushes_on_the_size_cap() {
        let cfg = CoalesceConfig {
            max_batch: 8,
            flush_after: Duration::from_millis(8),
        };
        let mut c = Coalescer::new(cfg);
        let t0 = Instant::now();
        assert!(c.push(b"1234", t0).is_none(), "under the cap stays pending");
        let batch = c
            .push(b"5678", t0)
            .expect("crossing the byte cap yields a batch");
        assert_eq!(batch, b"12345678");
        assert!(c.deadline().is_none(), "pending is empty after a flush");
    }

    #[test]
    fn coalescer_flushes_after_the_delay_but_not_before() {
        let cfg = CoalesceConfig {
            max_batch: 1024,
            flush_after: Duration::from_millis(8),
        };
        let mut c = Coalescer::new(cfg);
        let t0 = Instant::now();
        assert!(c.push(b"hi", t0).is_none());
        // Before the window elapses, no time-flush.
        assert!(c.flush_due(t0 + Duration::from_millis(4)).is_none());
        // After it, the pending bytes flush.
        let batch = c
            .flush_due(t0 + Duration::from_millis(9))
            .expect("time window elapsed");
        assert_eq!(batch, b"hi");
    }

    #[test]
    fn coalescer_drain_emits_trailing_bytes_once() {
        let mut c = Coalescer::new(CoalesceConfig::default());
        let t0 = Instant::now();
        c.push(b"tail", t0);
        assert_eq!(c.drain().as_deref(), Some(&b"tail"[..]));
        assert!(c.drain().is_none(), "a second drain is empty");
    }
}
