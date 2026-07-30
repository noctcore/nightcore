---
title: Policy
description: Deny, ask, and allow tiers evaluated per tool call — the pattern syntaxes that actually work, the edit-time diagnostics that block a bad save, and the pattern tester.
sidebar:
  order: 2
---

Structure-Lock checks a task *after* it has done its work. Policy governs the
agent *while* it works: it is evaluated in a `PreToolUse` hook, once per tool
call, before the tool runs.

Two properties define it:

- **It runs regardless of permission mode — including `bypassPermissions`.** The
  deny tier is not a permission prompt you can turn off.
- **It is configured by you, never by model output.** Policy lives in your
  project's `.nightcore/harness.json` under `policy`.

## The tiers, and their precedence

Deny always wins over ask; ask wins over allow. Concretely, the gate evaluates:

1. **`disallowedTools`** — tool-name denials
2. **`protectedPaths`** — write/mutation denials by path
3. **`denyReadPaths`** — read denials by path
4. **`denyBashPatterns`** — command-line denials by regex
5. **`askTools`** — the ask tier, reached only if nothing above denied

`allowTools` is **not evaluated by this gate at all**. It is a set of
auto-approval rules handed to the provider SDK, so it can never override a deny
— by construction, not by ordering.

### The implicit rule you always get

Whenever the policy layer is armed, `.nightcore/**` is prepended to
`protectedPaths` automatically. An agent cannot rewrite the manifest that
governs it, or the ledger that records it.

This is also why an armed-but-empty `policy` object is meaningful: it is how you
get the self-protection with no other rules.

### Arming semantics

| Manifest state | Result |
|---|---|
| No `.nightcore/harness.json` | No policy layer |
| Unreadable or malformed | Warning logged, no policy layer |
| `policy.enabled` is explicitly `false` | No policy layer |
| `policy` key absent, manifest present | **Layer arms** with an empty policy — so `.nightcore/**` self-protection still holds |

## Pattern syntaxes — what actually works

This is the part that trips people up, because the three tiers use three
different matchers. There is no glob *library* here; the semantics below are
exactly what is implemented.

### Path tiers (`protectedPaths`, `denyReadPaths`, `allowExecSinks`)

A repo-relative glob with a deliberately small vocabulary:

- `*` matches within a path segment; `**` matches across segments.
- A pattern **containing `/` is anchored** at the run's working directory. A
  pattern **without `/` floats** — it matches at any depth.
- A matched prefix protects the **whole subtree** beneath it.
- Matching is **case-insensitive**.
- `?`, `[...]` and `{a,b}` are **not** special — they match literally.

### `denyBashPatterns`

A **JavaScript regular expression** over the raw command line, case-sensitive.
Patterns are capped at 512 characters and the command is truncated to 16 KiB
before testing.

This is the tier people most often get wrong, because glob habits do not
transfer: in a regex, `.env*` matches `.en`, `.env`, `.envv` — `*` repeats the
previous character. The editor warns you about exactly this.

### `disallowedTools` and `askTools`

**Exact tool names**, case-sensitive. The single exception is MCP servers:
`mcp__<server>__*` matches every tool from that server by prefix.

### `allowTools`

Verbatim provider permission-rule strings — e.g. `WebSearch`,
`Bash(git status:*)`. This is the one tier that speaks the SDK's syntax rather
than Nightcore's, because it is passed straight through.

## Edit-time validation

The policy editor diagnoses every row as you type, at two severities, and the
contract is precise:

**An `error` blocks Save. A `warning` never does.**

Errors are things that can never match or can never mean what you wrote — an
empty entry, a leading `!` (negation is not supported), a Windows drive letter,
a `~`, a `..` segment, `{`/`}`/`?` in a path, a URL, an uncompilable regex, a
regex over the 512-character cap, a `(` in an exact-name tool tier, a `*` in a
tool name that is not the `mcp__…__*` form, or a case-variant of a known tool
(with a "did you mean" suggestion).

Warnings are things that are legal but probably not what you meant — a bare `*`
or `**` that matches every path, an absolute machine path, a regex wrapped in
`/…/` as if it were a literal, a glob-shaped pattern typed into the regex field,
or an unknown tool name.

There is one cross-field warning: an entry present in **both** `askTools` and
`disallowedTools` will never fire its ask, because deny wins.

The editor also counts **dead rules** — entries that can never match — and
refuses to save while any remain. A policy full of rules that silently never
fire is worse than no policy, because it reads as protection.

## The pattern tester

Sitting inside the editor, the tester answers the only question that matters:
*given what I have typed, what happens?*

It takes three probes:

| Probe | Verdicts returned |
|---|---|
| A repo-relative path | `Write` and `Read` |
| A Bash command line | `Bash` |
| A tool name | `Call` |

Each verdict shows the outcome (**Denied** / **Asks first** / **Allowed**), the
tier responsible, and **the exact pattern that matched** — including when the
match is the implicit `.nightcore/**` self-protection, which is labelled as
such.

Two design details make it trustworthy:

1. It tests the **draft**, not the saved file. You see the consequence before
   you commit to it.
2. It contains **no matching logic of its own** — it calls the same shared
   matchers the enforcement gate calls. A tester with its own implementation
   would be free to disagree with the thing it is testing.

## Starter packs

Rather than a blank text area, the editor offers curated packs — secret hygiene,
gate bypass, generated files and lockfiles, CI and hooks, no web egress,
migrations, plus profile-keyed packs for Rust workspaces, Tauri desktop apps and
monorepo boundaries.

Packs **only ever add deny/ask rules — never `allowTools`** — and applying one
is a draft edit you still have to review and save.

## The exec-sink ask gate

Separate from the policy tiers, and built in rather than configured, is a fixed
list of **execution-changing targets**: CI workflows, git and agent hooks,
`package.json` scripts. A write to any of them escalates to an interactive ask
**even under `bypassPermissions`**.

This closes a hole that neither workspace confinement nor the OS sandbox can:
the run's own working directory stays writable either way, so a one-shot RCE
through a planted hook or CI job would otherwise be in scope.

A project can only **widen** the exemption list (`allowExecSinks`), never
narrow the gate. Note that `allowExecSinks` has **no UI controls** — it is
reachable only by hand-editing the manifest.

## Diff budget

`policy.diffBudget` (`maxChangedLines`, `maxChangedFiles`) is edited here too,
and is consumed by the [verification gauntlet](../gates/) rather than by the
`PreToolUse` hook.

## Where the honesty is

- Policy is **lexical**: it inspects tool inputs. Writes that do not go through
  a tool call — a Bash redirect, a symlink — are not visible to it. That gap is
  what the [OS sandbox](../isolation/) exists to close, and the sandbox only
  exists on macOS.
- The known-tool list used for "did you mean" suggestions is hand-maintained. An
  unknown name is a *warning*, never an error, precisely because that list can
  be stale.
- **Codex does not support the policy layer at all.** It declares
  `supportsHarnessPolicy: false`, and a run against a project with an armed
  policy is refused rather than run ungoverned. See
  [Providers](../../reference/providers/).
