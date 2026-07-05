# Security Policy

## Supported Versions

Nightcore is pre-1.0 software under active development. Security fixes land on
`main` first. Tagged releases (when published) receive backports at the
maintainer's discretion.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| Older tags | Best effort |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you believe you have found a security issue in Nightcore:

1. **Email or DM the maintainer** via GitHub (`@Shironex`) with a private message, **or**
2. Open a **[GitHub Security Advisory](https://github.com/Shironex/nightcore/security/advisories/new)** (preferred when the repo is public).

Include as much detail as you can:

- Description of the issue and potential impact
- Steps to reproduce (PoC if available)
- Affected versions or commit SHA
- Suggested fix (optional)

### What to expect

- **Acknowledgment** within 7 days
- **Status update** within 14 days (triage, fix in progress, or need more info)
- **Coordinated disclosure** — we will agree on a timeline before any public post

We credit reporters in release notes when they want attribution.

## Scope

In scope:

- Remote code execution or privilege escalation through Nightcore itself
- Authentication or credential handling bugs in Nightcore's code paths
- Sandbox / worktree isolation bypasses in the Rust core or engine
- Injection or permission bypass in task prompts, MCP config, or sidecar protocol
- Dependency vulnerabilities with a demonstrated exploit path through Nightcore

Out of scope:

- Issues in **third-party services** (Anthropic, GitHub, Claude CLI) — report to them directly
- Social engineering or physical access to an unlocked machine
- Vulnerabilities in **your project code** that agents modify while you run tasks
- Denial-of-service from intentionally running many large agent sessions on your own machine

## Safe Usage

Nightcore runs AI agents with filesystem and shell access on projects you open.
Treat untrusted repositories and task descriptions as hostile input. Prefer git
worktree isolation, dedicated user accounts, or VMs when experimenting with
untrusted codebases.

See also the [Security Disclaimer](README.md#security-disclaimer) in the README.
