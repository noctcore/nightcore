/**
 * Canaries for the settings-scope generator (issue #404).
 *
 * The generator's job is to make the Settings surface's scope claims impossible to
 * drift from the Rust `SettingsOverride` shape. These tests pin the ways that job can
 * quietly fail: parsing a real binding and finding nothing, being fooled by the doc
 * comments ts-rs interleaves with the fields, and emitting a map the web can't consume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { emit, overridableKeys } from './gen-settings-scope';

const BINDING = path.resolve(
  import.meta.dir,
  '../../apps/web/src/lib/generated/SettingsOverride.ts',
);

describe('gen-settings-scope', () => {
  it('reads the real ts-rs binding and finds the override fields', () => {
    const keys = overridableKeys(fs.readFileSync(BINDING, 'utf8'));
    // The run-shaping fields the Rust resolver merges per project.
    expect(keys).toContain('defaultModel');
    expect(keys).toContain('permissionMode');
    expect(keys).toContain('mcpServers');
    expect(keys).toContain('contextPackEnabled');
    // Global-only settings live on `Settings`, never on the override.
    expect(keys).not.toContain('sandboxSessions');
    expect(keys).not.toContain('terminalYoloLaunch');
  });

  it('is not fooled by the doc comments ts-rs interleaves with fields', () => {
    const keys = overridableKeys(`
      export type SettingsOverride = { plain?: string,
      /**
       * A doc comment mentioning notAField?: string and other prose.
       */
      documented?: number, };
    `);
    expect(keys).toEqual(['plain', 'documented']);
  });

  it('refuses to emit a map that would mark every setting global', () => {
    expect(() => overridableKeys('export type SettingsOverride = {  };')).toThrow(
      /no fields/,
    );
  });

  it('fails loud when the binding no longer declares the type it parses', () => {
    expect(() => overridableKeys('export type Something = { a?: string };')).toThrow(
      /no `type SettingsOverride`/,
    );
  });

  it('fails loud when the override stops being a flat object', () => {
    expect(() =>
      overridableKeys('export type SettingsOverride = { a?: string } | { b?: string };'),
    ).toThrow(/flat object/);
  });

  it('emits a keyed map, marked generated, typed against the override shape', () => {
    const source = emit(['defaultModel', 'mcpServers']);
    expect(source).toContain('@generated');
    expect(source).toContain(
      'PROJECT_OVERRIDABLE_SETTINGS: Record<keyof SettingsOverride, true>',
    );
    const literal = source.slice(source.indexOf('= {') + 2, source.lastIndexOf('};') + 1);
    const parsed = new Function(`return ${literal}`)() as Record<string, true>;
    expect(parsed).toEqual({ defaultModel: true, mcpServers: true });
  });
});
