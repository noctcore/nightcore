<!--
Title: a conventional commit with a scope, for example `fix(core): keep a parked task parked`.
Nightcore is in maintenance mode: fixes, dependency and security updates, no new features.
CONTRIBUTING.md has the long version.
-->

## Summary

<!-- What changes and why, in one or two sentences. -->

Closes #

## Checklist

- [ ] `bun run lint && bun run typecheck && bun run test:all` pass locally
- [ ] Tests for behavior changes (when applicable)
- [ ] Regenerated codegen output (if contracts changed)
- [ ] Decision-register update in `docs/decisions/INDEX.md` (if an architecture decision changed)
- [ ] No live Claude sessions in tests: SDK boundaries stay stubbed
- [ ] No secrets, real hostnames, IPs or email addresses in code, fixtures or docs

## Test plan

<!-- Commands run, cases covered, what a reviewer can try. -->
