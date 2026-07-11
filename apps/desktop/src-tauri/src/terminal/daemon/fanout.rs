//! Per-session output fan-out with a sequence-numbered replay ring (cockpit spec
//! PR 6, §5.3) — Unix-only (the daemon is macOS/Linux, §5.6).
//!
//! Each daemon-owned session gets one [`Fanout`]. The session's `OutputSink` (handed
//! to the shared `terminal::session` machinery) routes every coalesced batch here,
//! which:
//!  1. stamps it with a monotonic `seq`,
//!  2. appends `(seq, bytes)` to a bounded ring (the **replay tail** — a reattaching
//!     app repaints from it), evicting oldest when over the byte budget, and
//!  3. if a client is subscribed, writes it live as a binary output frame.
//!
//! **Reattach without dup or loss.** `emit` and [`Fanout::subscribe`] both mutate the
//! ring + subscriber slot under ONE mutex, but neither holds it across a socket
//! write (a wedged old client must not block a relaunched app from taking over). The
//! critical sections are ordered so, for any `seq`, a newly-subscribed client
//! receives it EXACTLY once — via replay if the ring push happened-before the
//! subscribe snapshot, else via the live stream (see the module test).

#![cfg(unix)]

use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::protocol;

/// The replay-tail byte budget: enough to repaint a screen + recent scrollback on
/// reattach, bounded so a long-lived daemon never grows without limit (risk
/// register: secret-bearing buffers stay small + owner-only). The full history still
/// lives in the on-disk scrollback (`.nightcore/terminals/<id>.json`) for the
/// read-only-restore fallback — the ring is only the live-reattach tail.
const REPLAY_BUDGET_BYTES: usize = 1024 * 1024;

/// A connected client's shared write handle (responses + output frames both write
/// through it, serialized by the mutex; frames are atomic).
pub(crate) type ClientWriter = Arc<Mutex<UnixStream>>;

/// One buffered output batch awaiting (re)play.
struct RingEntry {
    seq: u64,
    bytes: Vec<u8>,
}

/// The bounded replay tail + the current live subscriber, under one lock.
struct FanoutState {
    ring: std::collections::VecDeque<RingEntry>,
    ring_bytes: usize,
    subscriber: Option<ClientWriter>,
}

/// One session's output multiplexer: seq counter + replay ring + live subscriber.
pub(crate) struct Fanout {
    id: String,
    next_seq: AtomicU64,
    state: Mutex<FanoutState>,
}

impl Fanout {
    pub(crate) fn new(id: String) -> Self {
        Self {
            id,
            next_seq: AtomicU64::new(1),
            state: Mutex::new(FanoutState {
                ring: std::collections::VecDeque::new(),
                ring_bytes: 0,
                subscriber: None,
            }),
        }
    }

    /// Route one coalesced output batch: stamp a seq, buffer it in the replay ring,
    /// and — if a client is subscribed — write it live. The socket write happens
    /// OUTSIDE the state lock; a dead subscriber (write error) is cleared.
    pub(crate) fn emit(&self, bytes: Vec<u8>) {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let subscriber = {
            let mut st = self.state.lock().expect("fanout state poisoned");
            st.push(seq, &bytes);
            st.subscriber.clone()
        };
        if let Some(writer) = subscriber {
            if !write_output(&writer, &self.id, seq, &bytes) {
                self.clear_subscriber(&writer);
            }
        }
    }

    /// Install `writer` as the live subscriber and replay every buffered batch with
    /// `seq > since_seq` to it. Ordered against [`emit`](Self::emit) so a concurrent
    /// batch is delivered exactly once (replay xor live). Returns `false` if the
    /// initial replay write failed (client already gone) so the caller drops it.
    pub(crate) fn subscribe(&self, writer: ClientWriter, since_seq: u64) -> bool {
        let replay: Vec<(u64, Vec<u8>)> = {
            let mut st = self.state.lock().expect("fanout state poisoned");
            st.subscriber = Some(writer.clone());
            st.ring
                .iter()
                .filter(|e| e.seq > since_seq)
                .map(|e| (e.seq, e.bytes.clone()))
                .collect()
        };
        for (seq, bytes) in replay {
            if !write_output(&writer, &self.id, seq, &bytes) {
                self.clear_subscriber(&writer);
                return false;
            }
        }
        true
    }

    /// Drop the current live subscriber if it is `writer` (a client disconnected, or
    /// a write to it failed). Leaves a subscriber installed by a newer client intact.
    pub(crate) fn clear_subscriber(&self, writer: &ClientWriter) {
        let mut st = self.state.lock().expect("fanout state poisoned");
        if st
            .subscriber
            .as_ref()
            .is_some_and(|s| Arc::ptr_eq(s, writer))
        {
            st.subscriber = None;
        }
    }
}

impl FanoutState {
    /// Append a batch, evicting oldest entries past the byte budget.
    fn push(&mut self, seq: u64, bytes: &[u8]) {
        self.ring.push_back(RingEntry {
            seq,
            bytes: bytes.to_vec(),
        });
        self.ring_bytes += bytes.len();
        while self.ring_bytes > REPLAY_BUDGET_BYTES && self.ring.len() > 1 {
            if let Some(evicted) = self.ring.pop_front() {
                self.ring_bytes = self.ring_bytes.saturating_sub(evicted.bytes.len());
            }
        }
    }
}

/// Best-effort framed output write; `false` on any I/O error (the caller drops the
/// subscriber). A poisoned write mutex is treated as a dead client.
fn write_output(writer: &ClientWriter, id: &str, seq: u64, bytes: &[u8]) -> bool {
    let Ok(mut w) = writer.lock() else {
        return false;
    };
    protocol::write_output(&mut *w, id, seq, bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connected socket pair: `writer` is the subscriber's shared handle; `reader`
    /// receives what the fanout writes.
    fn pair() -> (ClientWriter, UnixStream) {
        let (a, b) = UnixStream::pair().expect("socketpair");
        (Arc::new(Mutex::new(a)), b)
    }

    /// Drain `n` output frames off `reader`, returning their (seq, bytes).
    fn read_frames(reader: &mut UnixStream, n: usize) -> Vec<(u64, Vec<u8>)> {
        let mut out = Vec::new();
        while out.len() < n {
            match protocol::read_frame(reader).unwrap() {
                Some(protocol::Frame::Output(f)) => out.push((f.seq, f.bytes)),
                Some(other) => panic!("expected output frame, got {other:?}"),
                None => break,
            }
        }
        out
    }

    #[test]
    fn subscribe_replays_the_buffered_tail_then_streams_live() {
        let fan = Fanout::new("s1".to_string());
        fan.emit(b"one".to_vec()); // seq 1
        fan.emit(b"two".to_vec()); // seq 2 — buffered before any subscriber

        let (writer, mut reader) = pair();
        assert!(fan.subscribe(writer, 0), "subscribe from seq 0 replays all");
        let replayed = read_frames(&mut reader, 2);
        assert_eq!(
            replayed,
            vec![(1, b"one".to_vec()), (2, b"two".to_vec())],
            "the whole ring replays in order"
        );

        fan.emit(b"three".to_vec()); // seq 3 — live
        let live = read_frames(&mut reader, 1);
        assert_eq!(live, vec![(3, b"three".to_vec())]);
    }

    #[test]
    fn since_seq_skips_already_seen_output() {
        let fan = Fanout::new("s2".to_string());
        fan.emit(b"a".to_vec()); // 1
        fan.emit(b"b".to_vec()); // 2
        fan.emit(b"c".to_vec()); // 3
        let (writer, mut reader) = pair();
        // A client that already has through seq 2 only wants 3 onward.
        assert!(fan.subscribe(writer, 2));
        let got = read_frames(&mut reader, 1);
        assert_eq!(got, vec![(3, b"c".to_vec())]);
    }

    #[test]
    fn a_new_subscriber_takes_over_from_a_stale_one() {
        // Relaunch: an old (dead) subscriber is replaced; the new one gets subsequent
        // output. The old handle's reader is dropped so its writes fail silently.
        let fan = Fanout::new("s3".to_string());
        let (old_writer, old_reader) = pair();
        assert!(fan.subscribe(old_writer, 0));
        drop(old_reader); // the old client is gone

        let (new_writer, mut new_reader) = pair();
        assert!(fan.subscribe(new_writer, 0));
        fan.emit(b"after".to_vec()); // seq 1 → only the new subscriber
        let got = read_frames(&mut new_reader, 1);
        assert_eq!(got, vec![(1, b"after".to_vec())]);
    }

    #[test]
    fn the_ring_is_byte_bounded() {
        let fan = Fanout::new("s4".to_string());
        let chunk = vec![b'x'; 256 * 1024];
        for _ in 0..8 {
            fan.emit(chunk.clone()); // 8 * 256KiB = 2 MiB emitted, budget is 1 MiB
        }
        let (writer, mut reader) = pair();
        // Drain on a background thread so the replay's writes (which exceed the socket
        // buffer) never deadlock the single test thread — mirroring the real daemon,
        // where the client's reader drains concurrently with the server's writes.
        reader
            .set_read_timeout(Some(std::time::Duration::from_millis(300)))
            .unwrap();
        let drain = std::thread::spawn(move || {
            let mut total = 0usize;
            while let Ok(Some(protocol::Frame::Output(f))) = protocol::read_frame(&mut reader) {
                total += f.bytes.len();
            }
            total
        });
        fan.subscribe(writer, 0);
        let total = drain.join().expect("drain thread");
        assert!(
            total <= REPLAY_BUDGET_BYTES + chunk.len(),
            "the replay tail stays within roughly the byte budget, got {total}"
        );
        // Sanity: we didn't retain all 2 MiB.
        assert!(total < 2 * 1024 * 1024);
    }
}
