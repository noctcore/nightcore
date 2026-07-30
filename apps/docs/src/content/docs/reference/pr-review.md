---
title: PR review and the verdict clamp
description: A diff-grounded, five-lens review of a pull request whose verdict is mechanically bounded by the severities it found — and which posts nothing without your confirmation.
sidebar:
  order: 3
---

## The flow

1. **Create the PR.** Creating one from a task is gated on the merge bar: the
   task must be in worktree mode, committed, verified, and passing the pre-merge
   readiness gauntlet. Creation is single-flight — you cannot race two PRs for
   one task.
2. **Pick a PR** from the list of open pull requests.
3. **Fetch the diff.** The diff and changed-file list are fetched via the `gh`
   CLI and **capped at 512 KiB**.
4. **Review through five lenses**, each in its own **read-only** session — no
   Write, no Edit, no Bash, no web access. Grounding is **diff-relative**: a
   finding must point at the diff, not at something the model remembered about
   the repo.
5. **Finalise**, in a fixed order: diff-ground → exact de-duplication → fuzzy
   cross-lens corroboration → an adversarial validator → rank → synthesise a
   verdict → **clamp it**.
6. **Post — only if you confirm.**

## The verdict clamp

The scan produces a **merge verdict**, one of:

`ready` · `merge_with_changes` · `needs_revision` · `blocked`

The model is allowed to *propose* that verdict. It is not allowed to be the last
word on it. A mechanical rubric bounds the proposal to a band derived from the
**worst finding severity present**:

| Worst severity found | Allowed verdict band |
|---|---|
| *(no findings)* | `ready` only |
| `info` / `low` | `ready` … `merge_with_changes` |
| `medium` | `merge_with_changes` … `needs_revision` |
| `high` | `needs_revision` … `blocked` |
| `critical` | `blocked` only |

If the model's proposal falls outside the band it is clamped to the nearest
edge, and the result is marked as clamped **with the reason recorded**. You can
see that the model said `ready` and that the rubric overruled it.

The clamp is pure: it never mutates severities and never throws. It bounds the
conclusion, it does not rewrite the evidence.

**Why it exists:** the model has no mechanical floor. A miscalibrated `ready` on
a high-severity finding would otherwise sail through, and "the reviewer said it
was fine" is exactly the kind of claim this product refuses to accept without a
check behind it.

## Posting is human-gated, always

There is **no auto-post path**. No timer, no effect, no "post if verdict is
approve" shortcut. A single confirmed action is the only thing that reaches
GitHub, and it sends one atomic review request with the payload on **stdin, never
argv** (so nothing sensitive lands in a process listing).

The post dialog is pre-filled from the clamped verdict:

| Merge verdict | Pre-filled GitHub review |
|---|---|
| `ready` | approve |
| `merge_with_changes` | comment |
| `needs_revision` | request changes |
| `blocked` | request changes |

Findings at `critical`, `high` and `medium` are posted as **inline** comments;
`low` and `info` ride in the review body. Nothing is dropped.

### The own-PR guard

GitHub refuses approve and request-changes reviews on a pull request you
authored. Nightcore handles this in three places rather than letting you
discover it as an API error: the pre-fill downgrades to *comment* on your own
PR, the toolbar disables the other options with the reason shown, and a bare
HTTP 422 on a non-comment review is annotated with the actual explanation.

Authorship is derived from the `gh` viewer login versus the PR author, and
**fails open** — if the login cannot be determined, you are not locked out of
posting.

## Addressing findings

A companion runner takes findings (or CI failures, or conflicts) and works them
in a session. It is **not a board task**: no verification gate, no concurrency
slot, no persistent registry. Its lifecycle is
`running → committing → awaiting_push → pushed`, and the push is **human-gated
and never `--force`**.

## Per-PR lifecycle

The PR Review surface tracks each pull request through:

`not_reviewed` → `reviewing` → `reviewed_pending_post` → `posted`, plus
`fix_in_flight` and `stale`.

Unlike the other scan families, PR Review supports **concurrent runs** — one per
pull request.

## Where the honesty is

- The clamp bounds the verdict by the severities the scan **found**. It cannot
  bound it by a severity the scan missed. A clean `ready` on a review that saw
  nothing is exactly as informative as the review was thorough.
- The 512 KiB diff cap is real. A very large PR is reviewed on a truncated diff.
- The lenses are read-only *by configuration of the session's tools*. That is a
  meaningful constraint, not a proof of impossibility.
