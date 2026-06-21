#!/usr/bin/env bun
/**
 * Nightcore TUI entry — the daily-driver surface.
 *
 * Wires the engine façade to an OpenTUI + React view: it resolves config, builds
 * a `SessionManager`, creates the terminal renderer, and mounts `<App>`. The
 * surface speaks ONLY `SurfaceCommand`/`NightcoreEvent` — the SDK is never
 * imported here (enforced by the architectural eslint boundary).
 *
 * Run: `bun run apps/tui/src/index.ts`
 */
import { createElement } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { resolveConfig } from '@nightcore/config';
import { SessionManager } from '@nightcore/engine';
import type { PermissionMode } from '@nightcore/contracts';
import { App } from './App.js';

/** The TUI drives the two interactive modes; anything else from config maps to
 *  the safe default (plan = read-only). Shift+Tab flips plan ↔ build at runtime. */
function normalizeMode(mode: PermissionMode): PermissionMode {
  return mode === 'acceptEdits' ? 'acceptEdits' : 'plan';
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const manager = new SessionManager(config);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(
    createElement(App, {
      manager,
      config,
      defaults: {
        model: config.model,
        permissionMode: normalizeMode(config.permissions.mode),
      },
    }),
  );
}

void main();
