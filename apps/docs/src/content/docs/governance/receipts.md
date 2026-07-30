---
title: Receipts — the ledger, the journal, and the badge
description: The append-only files that record what an agent actually did and how a project is governed, and the trust summary and badge computed from them.
sidebar:
  order: 4
---

The gates decide what happens. The files on this page record it — and they are
what makes "inspectable" a property rather than a slogan. None of them contains
a model's account of itself.

## The flight recorder — `.nightcore/ledger/<taskId>.ndjson`

One NDJSON file per task, one JSON object per line, `ts` first.

**What lands in it:**

- Every tool decision: `{ ts, tool, inputDigest, decision, ruleId? }` where
  `decision` is `allow`, `deny`, or `ask`. One writer sees allows *and* denies,
  so the file is a complete record rather than an exception log.
- `session-start` and `session-end` markers with the session id.
- A single `truncated` marker if the size cap is reached.

**Design properties, and why each one is what it is:**

| Property | Why |
|---|---|
| **Append-only** | A record you can rewrite is not evidence. |
| **Fail-open** | A filesystem error disables the writer with a warning; it never blocks a tool call. Losing audit is bad, wedging an agent mid-run is worse. |
| **Bounded at 5 MiB** | A runaway session cannot fill your disk. The cap is marked in-band, so a truncated file says so. |
| **Digest, not payload** | Only one field per tool call is recorded, truncated to 200 characters — the command, path, URL, pattern, query or prompt. The full tool input is never written. |
| **Secret-redacted** | Redaction runs *before* truncation, so a secret cannot be preserved by being cut in half. |
| **Path is the project root** | Not the worktree. Build, reviewer and fix sessions for one task share one file. |

The ledger is not decorative — the gates read it. The anti-gaming sweep uses it
to detect a `--no-verify` bypass, and the "did the agent collide with your own
rails?" park decision in the [verification gauntlet](../gates/) is made by
reading policy denials out of it.

### Policy activity

The same ledger files feed a **policy activity feed** in the app: every `deny`
and `ask` across the project, newest first, capped at 200 entries. Allows are
dropped from this view — they are in the files, just not in the feed. Each entry
carries the task, timestamp, tool, digest, rule id, and whether the rule came
from **your policy** or from a **built-in** gate.

## The governance journal — `.nightcore/ledger/project.ndjson`

The ledger records what an *agent* did. The journal records what *governance*
did — the changes to the rules themselves.

Five kinds of entry, each written by a real code path:

| Kind | Written when |
|---|---|
| `policy-save` | You save the policy. **Counts only, never patterns** — e.g. "armed, 2 protected path(s), tools 0/1/0 (deny/ask/allow)". |
| `quarantine` | A save *adds* read-denial entries; the detail lists only the added paths. |
| `arm` | A Structure-Lock check is armed or re-enabled. |
| `disarm` | A check is disabled or removed. |
| `ratchet` | A strictness baseline is snapshotted. |

Each entry is a timestamp, a kind, a summary, and up to 8 detail lines — every
field control-character-collapsed, secret-redacted, and truncated (200
characters for the summary, 160 per detail line).

Like the ledger it is append-only by construction — opened `O_APPEND`, one write
per record, no rewrite/compact/truncate path exists in the module at all — and
best-effort: a failed append warns and is swallowed rather than failing your
save. Reads are lenient: an unparseable line is skipped **and counted**, so
corruption is surfaced rather than silently dropped.

Both files live in a directory that drops a self-ignoring `.gitignore` on first
write, so your governance history does not accidentally become a commit.

## The trust summary

The per-project trust summary aggregates all of the above on demand. It is
**computed, never stored** — caching it to a file would create a second source
of truth that could disagree with the ledger.

It reports:

- **Merges** — tasks, merged, verified, verified merges
- **Gauntlet** — runs, passed, and a pass rate that is *absent* rather than zero
  when nothing has ever run (a 0% that means "never measured" is a lie)
- **Guardrails** — tools evaluated, allowed / asked / denied, how many denials
  came from your policy versus built-in gates, top rules by hit count, sessions
- **Spend** — explicitly **approximate**: the last run per task only
- **Journal** — per-kind counts, corrupt-line count, most recent events

## The badge

The summary condenses into a shields.io-shaped badge — label `governance`, a
message like `12 verified merge(s) · 96% gauntlet · 3 denial(s)`, and a colour.

The colour is driven **solely by the gauntlet pass rate**:

| Pass rate | Colour |
|---|---|
| Never measured | grey — *"not measured"* |
| ≥ 95% **and** at least one verified merge | bright green |
| ≥ 85% | green |
| ≥ 60% | yellow |
| below 60% | orange |

Note the extra condition on the top band: a 100% pass rate over two runs with no
verified merge does not earn bright green.

**Export** writes the badge JSON to a file you choose. The destination is
validated — it must be absolute and must not contain a `.nightcore` path
component, because a badge written over `project.ndjson` would destroy the
journal it reports on.

## Where the honesty is

- **Spend is approximate.** It counts the last run per task. Do not reconcile it
  against a provider invoice.
- **The badge measures the gauntlet, not quality.** A project with one armed
  check that always passes can show bright green. The badge is a claim about
  *how consistently your own gates pass*, not about how good your gates are.
- **The ledger is fail-open.** If the filesystem misbehaves, records are lost
  rather than agents blocked. An empty ledger is not proof that nothing
  happened.
- **Codex sessions produce no ledger.** The provider declares
  `supportsLedger: false`. Unlike the policy layer, this is *not* currently a
  refusal condition — a Codex run proceeds without a flight recorder. See
  [Providers](../../reference/providers/).
