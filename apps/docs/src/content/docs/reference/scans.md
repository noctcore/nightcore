---
title: Scans
description: The five scan families, what each one produces, which support deep mode, and the run states they share.
sidebar:
  order: 2
---

A **scan** is a read-only analysis run. Every scan family shares the same
lifecycle, the same run store, and the same "convert this result into a board
task" affordance — which is the point: a finding that cannot become work is
just an opinion.

## The five families

| Family | Unit of work | Produces | Deep mode |
|---|---|---|---|
| **Insight** (Find) | 9 categories | Severity- and effort-ranked findings, each pinned to a file and line | yes |
| **Harness** (Propose / Conventions) | 8 convention categories | Conventions and gaps, a repo profile, proposed artifacts, proposals | yes |
| **Scorecard** (Grade) | 10 dimensions | A–F readings with evidence | no |
| **PR Review** | 5 lenses | Review findings + a clamped merge verdict | yes |
| **Issue Triage** | 1 issue, single pass | One validation verdict | no |

**All five convert their results into board tasks.**

### Category and dimension lists

- **Insight** — `architecture`, `bugs`, `refactor`, `performance`, `security`,
  `tests`, `docs`, `ui-ux`, `dependencies`. Scope: whole repo or diff.
- **Harness** — `architecture`, `folder-structure`, `naming`,
  `imports-boundaries`, `design-decisions`, `tooling-lint`, `testing`,
  `agent-context`. Each result is a `convention` or a `gap`.
- **Scorecard** — `architecture`, `tests`, `security`, `error-handling`,
  `observability`, `dependencies`, `performance`, `types`, `a11y`, `docs-ci`.
- **PR Review** — lenses `security`, `logic`, `structure`, `tests`, `contracts`.
- **Issue Triage** — verdict `valid` / `invalid` / `needs_clarification`; kind
  `bug_report` / `feature_request` / `question` / `unknown`.

## Run states

The persisted status of a run is `running`, `completed`, or `failed`. The UI
adds `idle` for "nothing has run yet", and derives a three-phase screen from it:
**Configure → Running → Results**.

Two behaviours worth knowing:

- Runs interrupted by a crash are **reaped at boot** — they do not sit as
  `running` forever.
- The run store keeps a bounded history (the most recent runs), so it does not
  grow without limit.

## Deep mode

Deep mode is available on **Insight, Harness, and PR Review** — not on Scorecard
or Issue Triage.

Classic mode runs each category or lens once, with one corrective retry. Deep
mode runs it as a **multi-round loop**: each round is shown the findings already
collected and asked for *new distinct* ones. Results accumulate and are
de-duplicated across rounds. The loop ends when it **converges** — by default
two consecutive rounds that add nothing new — or when it hits the per-category
round backstop.

Defaults: 15 rounds maximum per category, convergence after 2 empty rounds, 20
findings maximum per round.

:::caution[The round cap is not a budget]
`maxRoundsPerCategory` exists **only to guarantee termination**. It is not a cost
control. Deep mode does substantially more model work than a classic scan; treat
it as a deliberate spend, not a better default.
:::

Rounds are sequential within one category's slot, but categories still run in
parallel — so deep mode is slower per category, not serialised overall.

## What scans do not do

- They do not modify your repository. The one exception is applying a Harness
  **artifact**, which is an explicit action you take on a proposal, not something
  a scan does.
- They do not run your tests. A finding is grounded in code the model read, not
  in an execution.
- They are not deterministic. Two runs of the same scan on the same repo can
  return different sets. Deep mode narrows this by construction — it keeps going
  until rounds stop adding anything — but does not eliminate it.
