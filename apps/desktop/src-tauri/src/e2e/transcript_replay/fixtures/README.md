# Transcript-replay fixtures (issue #278)

Deterministic, checked-in sidecar-output transcripts replayed through the reader's
correlation + finalizer seams as regression fixtures. Each file is **NDJSON**: one
serialized sidecar event per line, in wire order — the same shape a real run's
`nc:session` stream (and, for scans, the `nc:insight` / `nc:pr-review` channels)
carries, and the exact shape the per-task on-disk transcript
(`<project>/.nightcore/tasks/<id>/transcript.jsonl`) is written in by
`crate::store::transcript::append_line`.

The replay drivers live in `../{build,scan,pr_review}.rs`; the shared line parser is
`../replay.rs`.

## Recorded-real vs constructed-representative

**Constructed-representative.** No recorded-real transcript exists to check in: the
per-task `transcript.jsonl` files are project-scoped runtime artifacts (none present
in-repo, and they would carry only `session-*` events — the scan/pr-review families
correlate by `runId` and are never persisted to a task transcript), and the app log
dir (`~/Library/Logs/dev.shirone.nightcore`) holds `tracing` lines, not NDJSON.

Every line is instead **grounded in the codegen'd contract**, not invented:

- The event/field shapes are taken verbatim from
  `apps/desktop/src-tauri/src/contracts/fixtures.json` — the canonical wire payload
  per event `type`, emitted alongside `generated.rs` from the `@nightcore/contracts`
  zod source (regenerate with `bun run codegen:contracts`). The `session-ready`,
  `assistant-delta`, `tool-use-requested`, `tool-result`, `session-completed`,
  `analysis-*`, and `pr-review-*` shapes here match those fixtures field-for-field.
- The finding objects match the reader-side parsers exactly
  (`StoredFinding::from_wire`, `StoredReviewFinding::from_wire`,
  `FindingLocation::from_wire`) — the same camelCase keys those `from_wire`s read.

A `fixtures_are_wire_shaped` test (in `../replay.rs`) asserts every line parses and
carries a string `type`, so a malformed fixture fails loudly rather than silently
replaying nothing.

## Files

| File | Run kind | Represents |
| --- | --- | --- |
| `build.jsonl` | build (session-correlated) | `session-ready` → assistant deltas + `Edit`/`Bash` tool calls → `session-completed` |
| `insight-scan.jsonl` | Insight scan (runId-correlated) | `analysis-started` → three category passes (one bug + one security finding) → `analysis-completed` |
| `pr-review.jsonl` | PR review (runId-correlated) | `pr-review-started` → five lens passes (one security finding) → `pr-review-completed` with a `request-changes` verdict |

## Regenerating / extending

These are authored by hand against `contracts/fixtures.json`. To add a run kind or an
event, copy the canonical shape for that `type` out of `fixtures.json` (never invent a
shape — the reader parses by exact key) and append it as one NDJSON line. Keep the
lines in wire order; the drivers replay them top-to-bottom.
