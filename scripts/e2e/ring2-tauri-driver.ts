#!/usr/bin/env bun
/**
 * E2E ladder **ring 2** — the real desktop app, driven by a real WebDriver (#406).
 *
 * ## Why this ring is Linux-only, and why it is the only one of its kind
 *
 * macOS's WKWebView exposes no CDP and no WebDriver endpoint — the constraint that
 * shapes every other tier of this ladder (`reference_nightcore_ui_testing`, and the
 * reason `dogfood:ui` drives a mock web app at :5173 instead of the app). Linux's
 * WebKitGTK ships `WebKitWebDriver`, which `tauri-driver` fronts, so Linux is the ONE
 * platform where CI can drive the actual Tauri window. Everything below therefore runs
 * on ubuntu only, under Xvfb.
 *
 * It is also the only tier that exercises the layer nothing else touches: the Tauri
 * window + WebKit webview + the IPC bridge into the Rust core, in the SHIPPED binary.
 * Ring 1 has no webview; the vitest browser suite has no Rust; ring 3 has no window.
 *
 * ## What it asserts (and why each check cannot pass vacuously)
 *
 *  1. the window came up and is titled — the app process launched at all;
 *  2. `window.__TAURI_INTERNALS__` exists AND the app's own "Browser preview" banner is
 *     absent — we are in the real webview, not accidentally pointed at a dev server
 *     serving mock data (the single most likely way this ring becomes a lie);
 *  3. `invoke('app_info')` returns the version compiled into the binary — a real IPC
 *     round-trip into Rust and back, not a painted bundle;
 *  4. `invoke('list_tasks')` returns exactly the tasks this script seeded on disk —
 *     the Rust store read OUR state, so the run is hermetic and the count is known;
 *  5. the seeded task titles are present in the rendered DOM — React rendered data
 *     that came from Rust, which is the actual end-to-end claim;
 *  6. no `*.corrupt-*` file appeared in the seeded config dir — a quarantined store
 *     would otherwise leave an empty board that satisfies a weaker assertion.
 *
 * ## SELF-TEST — why this job cannot pass with the app broken
 *
 * The self-test (on by default) perturbs the LIVE app and requires the battery to
 * trip. One perturbation per check kind, each verified BY EFFECT:
 *
 *   - `dom`     — empty `#root` and blank the title;
 *   - `ipc`     — create a task through the app's own `create_task` command, mutating
 *                 the real Rust store, so `list_tasks` stops matching the seeded ids;
 *   - `disk`    — plant a quarantine file where the tripwire looks;
 *   - `session` — end the app (the backstop for the two checks nothing narrower can
 *                 falsify: a compiled-in version, and the presence of the webview shim).
 *
 * THREE ways to fail: a check that survives its own perturbation, a check kind with no
 * perturbation at all, or a perturbation that cannot verify it landed. That last rule
 * is what killed the obvious-but-wrong first attempt — monkey-patching the page.
 * Tauri's `__TAURI_INTERNALS__` is non-configurable and its `invoke` non-writable, so
 * the stub was silently discarded and the self-test accused two perfectly good checks
 * of being vacuous. Breaking real state beats faking a break. Same contract as
 * `scripts/verify-drift-guard.ts`.
 *
 * ## Usage
 *
 *   bun run e2e:ring2                       # binary from the default debug path
 *   bun run e2e:ring2 -- --binary <path>    # explicit binary
 *   bun run e2e:ring2 -- --no-self-test     # battery only
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { waitForDriver,WebDriverSession } from './webdriver.js';

const REPO = path.resolve(import.meta.dir, '../..');
const FIXTURES = path.join(
  REPO,
  'apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
);
/** Where `tauri build --debug --no-bundle` leaves the executable. Both spellings are
 *  probed: cargo names it after the crate (`nightcore`), while some Tauri CLI versions
 *  rename it to `productName`. Resolving instead of assuming keeps a CLI upgrade from
 *  turning this ring into a "binary not found" red for a reason unrelated to the app. */
const BINARY_CANDIDATES = ['nightcore', 'Nightcore'].map((name) =>
  path.join(REPO, 'apps/desktop/src-tauri/target/debug', name),
);
/** The Tauri identifier — `app_config_dir()` joins THIS, never productName. */
const APP_IDENTIFIER = 'dev.shirone.nightcore';
const DRIVER_URL = 'http://127.0.0.1:4444';
/** The app shows a splash for a fixed 1400 ms and clears it once the boot reads
 *  settle; give it comfortable headroom on a cold CI runner before asserting. */
const BOOT_SETTLE_MS = 6_000;

interface Check {
  name: string;
  /** What the check actually reads, which is the same thing as: what would have to be
   *  destroyed for it to fail. `dom` = rendered content, `ipc` = live backend state
   *  over a Tauri round-trip, `disk` = the app's on-disk state, `session` = something
   *  only a running app can answer at all (a compiled constant, the webview shim).
   *  The tag drives the self-test — each perturbation targets ONE kind and demands
   *  that every check in it fails — so a check must be tagged by what destroying it
   *  would break, not by what it feels related to. Mis-tagging is caught: the ring's
   *  first CI run had the webview-shim check tagged `dom`, and emptying `#root`
   *  (correctly) left it standing. */
  kind: 'dom' | 'ipc' | 'disk' | 'session';
  run: (session: WebDriverSession) => Promise<{ ok: boolean; detail: string }>;
}

/** The seeded board. Titles are distinctive so finding them in the DOM cannot be an
 *  accident (a substring of the app's own chrome would make check 5 vacuous). */
const SEED_TASKS = [
  { id: 'ring2-alpha', title: 'ring2 seeded alpha task', status: 'backlog' },
  { id: 'ring2-bravo', title: 'ring2 seeded bravo task', status: 'ready' },
  { id: 'ring2-charlie', title: 'ring2 seeded charlie task', status: 'done' },
];

interface Workspace {
  /** The throwaway root holding everything below (removed at the end of the run). */
  root: string;
  /** XDG_CONFIG_HOME for the app run. */
  xdgConfigHome: string;
  /** XDG_DATA_HOME for the app run — where its rolling log lands. */
  xdgDataHome: string;
  /** `<xdgConfigHome>/<identifier>` — where projects.json/settings.json land. */
  configDir: string;
  /** The scratch git repo the seeded project points at. */
  projectPath: string;
}

/** Create a throwaway XDG config/data home + scratch project with a seeded board. */
function seedWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ring2-'));
  const xdgConfigHome = path.join(root, 'config');
  const xdgDataHome = path.join(root, 'data');
  const configDir = path.join(xdgConfigHome, APP_IDENTIFIER);
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.nightcore/tasks'), { recursive: true });
  // A real git dir: the project is a git repo everywhere in the core's model, and a
  // bare marker is enough for the boot reads (no run is launched by this ring).
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });

  const now = Date.now();
  fs.writeFileSync(
    path.join(configDir, 'projects.json'),
    JSON.stringify(
      [
        {
          id: 'ring2-project',
          name: 'Ring 2 scratch',
          path: projectPath,
          branch: null,
          createdAt: new Date(now).toISOString(),
          lastActiveAt: null,
        },
      ],
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(configDir, 'active.json'),
    JSON.stringify({ activeProjectId: 'ring2-project' }),
  );
  for (const task of SEED_TASKS) {
    fs.writeFileSync(
      path.join(projectPath, '.nightcore/tasks', `${task.id}.json`),
      JSON.stringify({
        id: task.id,
        title: task.title,
        description: '',
        status: task.status,
        dependencies: [],
        model: null,
        branch: null,
        createdAt: now,
        updatedAt: now,
        sessionId: null,
        summary: null,
        error: null,
        costUsd: null,
      }),
    );
  }
  return { root, xdgConfigHome, xdgDataHome, configDir, projectPath };
}

/** Tail the app's own rolling log. This ring is developed and debugged through CI (no
 *  macOS developer can run tauri-driver locally), so a failure that prints only
 *  "check X failed" is a failure nobody can diagnose. */
function appLogTail(workspace: Workspace, lines = 80): string {
  const dir = path.join(workspace.xdgDataHome, APP_IDENTIFIER, 'logs');
  if (!fs.existsSync(dir)) return `(no app log dir at ${dir})`;
  const files = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) return `(app log dir ${dir} is empty)`;
  return fs.readFileSync(files[0]!, 'utf8').split('\n').slice(-lines).join('\n');
}

/** The version compiled into the binary, read from the crate manifest so the check
 *  can never drift into comparing a constant against itself. */
function expectedVersion(): string {
  const manifest = fs.readFileSync(
    path.join(REPO, 'apps/desktop/src-tauri/Cargo.toml'),
    'utf8',
  );
  const match = /^version = "([^"]+)"/m.exec(manifest);
  if (match === null) throw new Error('could not read version from Cargo.toml');
  return match[1]!;
}

/** Invoke a Tauri command from inside the page and return its result or an error. */
const INVOKE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    done({ ok: false, error: 'no __TAURI_INTERNALS__.invoke' });
  } else {
    Promise.resolve(internals.invoke(arguments[0], arguments[1] || {}))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({ ok: false, error: String(error) }));
  }
`;

type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function invoke<T>(
  session: WebDriverSession,
  command: string,
  args: Record<string, unknown> = {},
): Promise<InvokeResult<T>> {
  return session.executeAsync<InvokeResult<T>>(INVOKE_SCRIPT, [command, args]);
}

function buildChecks(workspace: Workspace): Check[] {
  const version = expectedVersion();
  return [
    {
      name: 'the Tauri window opened and is titled Nightcore',
      kind: 'dom',
      run: async (session) => {
        const title = await session.title();
        return { ok: title === 'Nightcore', detail: `title=${JSON.stringify(title)}` };
      },
    },
    {
      name: 'we are in the REAL webview, not a browser-preview dev server',
      // `session`, not `dom`: this reads the Tauri runtime shim, not rendered content,
      // so emptying #root must NOT be expected to trip it. And the shim cannot be
      // revoked from inside the page (non-configurable), so its only honest
      // perturbation is ending the app.
      kind: 'session',
      run: async (session) => {
        // Two independent signals: the Tauri IPC shim exists, AND the app's own
        // "you are not in Tauri" banner is absent. Either alone could be fooled.
        const probe = await session.execute<{ internals: boolean; banner: boolean }>(`
          return {
            internals: typeof window.__TAURI_INTERNALS__ === 'object' && window.__TAURI_INTERNALS__ !== null,
            banner: (document.body.innerText || '').includes('Browser preview'),
          };
        `);
        return {
          ok: probe.internals && !probe.banner,
          detail: `internals=${probe.internals} previewBanner=${probe.banner}`,
        };
      },
    },
    {
      name: 'the app shell painted a non-trivial DOM',
      kind: 'dom',
      run: async (session) => {
        const count = await session.execute<number>(
          "return document.querySelectorAll('#root *').length;",
        );
        // A white screen (React crashed on mount, CSP blocked the bundle, assets
        // missing) leaves #root empty or nearly so; a real shell is hundreds of nodes.
        return { ok: count > 50, detail: `${count} elements under #root` };
      },
    },
    {
      name: 'app_info round-tripped through the Rust core',
      // `session`, not `ipc`: the version it returns is compiled into the binary, so no
      // runtime change can move it. Only ending the app falsifies this one.
      kind: 'session',
      run: async (session) => {
        const result = await invoke<{ version: string }>(session, 'app_info');
        const ok = result.ok && result.value.version === version;
        return {
          ok,
          detail: result.ok
            ? `version=${result.value.version} (expected ${version})`
            : `invoke failed: ${result.error}`,
        };
      },
    },
    {
      name: 'list_tasks returned exactly the board this ring seeded on disk',
      kind: 'ipc',
      run: async (session) => {
        const result = await invoke<Array<{ id: string }>>(session, 'list_tasks');
        if (!result.ok) return { ok: false, detail: `invoke failed: ${result.error}` };
        const ids = result.value.map((t) => t.id).sort();
        const want = SEED_TASKS.map((t) => t.id).sort();
        return {
          ok: JSON.stringify(ids) === JSON.stringify(want),
          detail: `got [${ids.join(', ')}] want [${want.join(', ')}]`,
        };
      },
    },
    {
      name: 'the seeded task titles are rendered in the live DOM',
      kind: 'dom',
      run: async (session) => {
        const text = await session.execute<string>(
          'return document.body.innerText || "";',
        );
        const missing = SEED_TASKS.filter((t) => !text.includes(t.title));
        return {
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? `all ${SEED_TASKS.length} seeded titles present`
              : `missing: ${missing.map((t) => t.title).join(', ')}`,
        };
      },
    },
    {
      name: 'no store file was quarantined as corrupt during the run',
      kind: 'disk',
      run: () => {
        // The core quarantines an unparsable projects.json/settings.json to
        // `<name>.corrupt-<millis>` and carries on with an EMPTY registry — which
        // would leave a board that still satisfies weaker checks. This is the
        // tripwire for a seed that silently stopped matching the Rust structs.
        const corrupt = fs
          .readdirSync(workspace.configDir)
          .filter((f) => f.includes('.corrupt-'));
        return Promise.resolve({
          ok: corrupt.length === 0,
          detail: corrupt.length === 0 ? 'clean' : `quarantined: ${corrupt.join(', ')}`,
        });
      },
    },
  ];
}

interface Outcome {
  name: string;
  kind: Check['kind'];
  ok: boolean;
  detail: string;
}

async function runChecks(
  session: WebDriverSession,
  checks: Check[],
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const check of checks) {
    try {
      const { ok, detail } = await check.run(session);
      outcomes.push({ name: check.name, kind: check.kind, ok, detail });
    } catch (error) {
      outcomes.push({
        name: check.name,
        kind: check.kind,
        ok: false,
        detail: String(error),
      });
    }
  }
  return outcomes;
}

/**
 * Perturb the live app and require the matching checks to trip. A check that still
 * passes after the thing it claims to read has been destroyed is not reading it.
 */
async function selfTest(
  session: WebDriverSession,
  checks: Check[],
  workspace: Workspace,
): Promise<boolean> {
  console.log('\n══ SELF-TEST: perturb the live app, require the checks to trip ══');
  let allTripped = true;

  // One perturbation per check KIND, so every check in the battery is covered: a kind
  // with no perturbation would be a check nobody ever saw fail.
  //
  // Every perturbation VERIFIES BY EFFECT that it landed, and a perturbation that
  // cannot prove it perturbed is itself a self-test failure — it proved nothing about
  // the checks it targets. That rule paid for itself on the first two CI runs of this
  // ring, which killed the obvious-but-wrong strategy of monkey-patching the page:
  //
  //   - `window.__TAURI_INTERNALS__.invoke = stub` is a SILENT no-op — Tauri defines
  //     that property non-writable and WebDriver scripts run sloppy-mode, so the
  //     assignment is discarded with no error;
  //   - `delete window.__TAURI_INTERNALS__` / `Object.defineProperty` on it throws
  //     `Attempting to change configurable attribute of unconfigurable property`.
  //
  // Tauri's IPC surface is frozen from inside the page, by design. So the perturbations
  // below break the REAL thing instead: real backend state through the app's own
  // command surface, a real file on disk, and a real teardown of the app.
  const perturbations: Array<{
    label: string;
    kind: Check['kind'];
    apply: () => Promise<{ applied: boolean; detail: string }>;
  }> = [
    {
      label: 'empty #root (the webview rendered nothing)',
      kind: 'dom',
      // Also blanks the title, so the window-title check is covered by the same
      // perturbation rather than being exempted from the proof. The DOM is ours to
      // mutate — unlike Tauri's internals — so this one applies cleanly.
      apply: () =>
        session.execute<{ applied: boolean; detail: string }>(`
          const root = document.querySelector('#root');
          if (root) root.innerHTML = '';
          document.title = '';
          const left = document.querySelectorAll('#root *').length;
          return { applied: left === 0 && document.title === '', detail: left + ' nodes left' };
        `),
    },
    {
      label: 'change the board through the REAL backend (create_task over live IPC)',
      kind: 'ipc',
      // Not a stub: this drives the app's own `create_task` command, which mutates the
      // Rust TaskStore for real. `list_tasks` must then stop matching the seeded ids.
      // That proves the check reads LIVE backend state rather than a boot-time
      // snapshot or a canned answer — a stronger claim than "invoke can be broken".
      apply: async () => {
        const created = await invoke(session, 'create_task', {
          title: 'ring2 self-test injected task',
          description: '',
        });
        if (!created.ok) {
          return { applied: false, detail: `create_task failed: ${created.error}` };
        }
        const after = await invoke<Array<{ id: string }>>(session, 'list_tasks');
        const count = after.ok ? after.value.length : -1;
        return {
          applied: count > SEED_TASKS.length,
          detail: `list_tasks now returns ${count} task(s), seeded ${SEED_TASKS.length}`,
        };
      },
    },
    {
      label: 'plant a quarantine file (a store was found corrupt)',
      kind: 'disk',
      // The quarantine tripwire is the check most likely to sit green forever — it
      // asserts an ABSENCE, and an absence is exactly what a check looking in the
      // wrong directory also reports. Planting the file it looks for proves it looks.
      apply: () => {
        const planted = path.join(workspace.configDir, 'projects.json.corrupt-0');
        fs.writeFileSync(planted, '{}');
        return Promise.resolve({
          applied: fs.existsSync(planted),
          detail: `planted ${path.basename(planted)}`,
        });
      },
    },
    {
      label: 'END THE APP (nothing can be answered without it)',
      kind: 'session',
      // The backstop, and it MUST run last — it tears the app down.
      //
      // Two checks have no narrower perturbation available, honestly: the version
      // `app_info` returns is compiled into the binary and cannot change at runtime,
      // and `__TAURI_INTERNALS__`'s presence cannot be revoked from inside the page
      // (see the note above). Rather than drop them or fake a perturbation, they are
      // proven against the strongest change that IS available — the app ceasing to
      // exist. That is a weaker claim than the targeted perturbations make (it shows
      // the checks cannot be answered without a live app, not that they read the right
      // field), and it is stated as such rather than dressed up.
      apply: async () => {
        await session.close();
        try {
          await session.title();
          return { applied: false, detail: 'the session still answers after DELETE' };
        } catch {
          return { applied: true, detail: 'the WebDriver session is gone' };
        }
      },
    },
  ];

  const kinds = new Set(checks.map((c) => c.kind));
  for (const kind of kinds) {
    if (!perturbations.some((p) => p.kind === kind)) {
      console.error(
        `✖ SELF-TEST: check kind '${kind}' has no perturbation — those checks are unproven`,
      );
      allTripped = false;
    }
  }
  // The teardown perturbation destroys the app, so anything after it would run against
  // a corpse and "trip" for the wrong reason. Pinned rather than commented: a reorder
  // during a future edit would otherwise silently turn the remaining perturbations
  // into free passes.
  if (perturbations.at(-1)?.kind !== 'session') {
    console.error(
      '✖ SELF-TEST: the app-teardown perturbation must run LAST — everything after it would trip vacuously',
    );
    allTripped = false;
  }

  for (const perturbation of perturbations) {
    const applied = await perturbation.apply();
    if (!applied.applied) {
      console.error(
        `✖ PERTURBATION FAILED TO APPLY: ${perturbation.label} — ${applied.detail}.\n` +
          '    Nothing was proven about the checks it targets; fix the perturbation.',
      );
      allTripped = false;
      continue;
    }
    const targeted = checks.filter((c) => c.kind === perturbation.kind);
    const outcomes = await runChecks(session, targeted);
    const survivors = outcomes.filter((o) => o.ok);
    const tripped = survivors.length === 0;
    console.log(
      `${tripped ? '✔' : '✖'} ${perturbation.label} — ${outcomes.length} check(s), ${
        outcomes.length - survivors.length
      } tripped`,
    );
    for (const survivor of survivors) {
      console.error(`    ✖ VACUOUS: "${survivor.name}" still passed — ${survivor.detail}`);
    }
    if (!tripped) allTripped = false;
  }

  if (!allTripped) {
    console.error(
      '\n✖ SELF-TEST: at least one check passes with the app broken. That check is not reading the app.',
    );
  } else {
    console.log(
      '\n✔ SELF-TEST: every check tripped when its subject was destroyed — the battery reads the live app',
    );
  }
  return allTripped;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const explicit = argValue('--binary');
  const binary =
    explicit ?? BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  const wantSelfTest = !process.argv.includes('--no-self-test');
  if (binary === undefined || !fs.existsSync(binary)) {
    console.error(
      `✖ app binary not found (looked at ${BINARY_CANDIDATES.join(', ')})\n` +
        '  build it first: cd apps/desktop && bunx tauri build --debug --no-bundle',
    );
    process.exit(1);
  }

  const workspace = seedWorkspace();
  console.log(`ring 2 binary:    ${binary}`);
  console.log(`ring 2 workspace: ${workspace.configDir}`);
  console.log(`ring 2 project:   ${workspace.projectPath}`);

  // tauri-driver launches the app as its own child, so the app inherits THIS env:
  // the throwaway config/data homes (hermetic state + a log we can tail) and the
  // replay switch (so nothing in the app can reach a real provider even if a run were
  // somehow launched). No credential is placed in the environment.
  const driver = spawn('tauri-driver', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: workspace.xdgConfigHome,
      XDG_DATA_HOME: workspace.xdgDataHome,
      NIGHTCORE_E2E_REPLAY: FIXTURES,
    },
  });
  const driverLog: string[] = [];
  driver.stdout?.on('data', (c: Buffer) => driverLog.push(c.toString('utf8')));
  driver.stderr?.on('data', (c: Buffer) => driverLog.push(c.toString('utf8')));

  let ok = false;
  let session: WebDriverSession | undefined;
  try {
    await waitForDriver(DRIVER_URL);
    session = await WebDriverSession.open({ url: DRIVER_URL, application: binary });
    // The splash is a fixed 1400 ms plus the boot reads; assert only after it clears.
    await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS));

    const checks = buildChecks(workspace);
    const outcomes = await runChecks(session, checks);
    console.log('\n══ E2E ladder ring 2 — tauri-driver × the real desktop app ══');
    for (const outcome of outcomes) {
      console.log(`${outcome.ok ? '✔' : '✖'} ${outcome.name}\n    ${outcome.detail}`);
    }
    ok = outcomes.every((o) => o.ok);

    // Only meaningful once the battery is green: proving that a FAILING check trips is
    // no proof at all. Perturbation also leaves the app unusable, so it runs last.
    if (ok && wantSelfTest) ok = await selfTest(session, checks, workspace);
    else if (!ok && wantSelfTest) {
      console.log('\n(self-test skipped: the battery is already red — fix that first)');
    }
  } catch (error) {
    console.error(`✖ ring 2 driver error: ${String(error)}`);
  } finally {
    // Diagnostics on ANY red, not just a thrown error: this ring can only be debugged
    // from a CI log, so a failing check must ship the app's own log with it.
    if (!ok) {
      console.error(`\n── tauri-driver log ──\n${driverLog.join('').slice(-2000)}`);
      console.error(`\n── app log ──\n${appLogTail(workspace)}`);
    }
    if (session) await session.close();
    driver.kill();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }

  console.log(ok ? '\n✔ ring 2 green' : '\n✖ ring 2 RED');
  process.exit(ok ? 0 : 1);
}

await main();
