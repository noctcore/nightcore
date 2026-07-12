/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  isSensitiveExportName,
  REDACTED,
  redactSecrets,
  SENSITIVE_EXPORT_EXCLUDE,
} from './secret-redaction.js';

describe('redactSecrets', () => {
  test('masks an Authorization: Bearer header token (command shape survives)', () => {
    const out = redactSecrets(
      'curl -H "Authorization: Bearer sk-live-abcdef0123456789ABCDEF"',
    );
    // The `Authorization` name is on the denylist, so its whole value is masked (the
    // Bearer scheme word included) — strictly safer than keeping the scheme.
    expect(out).not.toContain('sk-live-abcdef0123456789ABCDEF');
    expect(out).toContain(REDACTED);
    // The command shape survives so the digest still reads as a curl auth call.
    expect(out).toContain('curl -H');
  });

  test('a bare Bearer token keeps the scheme and masks only the token', () => {
    const out = redactSecrets('grpc-header bearer=x Bearer abcDEF0123456789ghiJKL');
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).not.toContain('abcDEF0123456789ghiJKL');
  });

  test('masks well-known vendor token prefixes', () => {
    for (const secret of [
      'sk-ant-api03-ABCDEFGHIJKLMNOPqrstuvwx',
      'ghp_0123456789abcdefABCDEF0123456789abcd',
      'github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUV',
      'xoxb-1111111111-2222222222-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyA-1234567890abcdefghijklmnopqrstuv',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    ]) {
      const out = redactSecrets(`export TOKEN=${secret}`);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
    }
  });

  test('masks a PEM private-key block whole', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\nabcdef==\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`echo "${pem}"`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA');
    expect(out).toContain(REDACTED);
  });

  test('masks the VALUE of a sensitive NAME=value assignment, keeping the name', () => {
    const out = redactSecrets(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY DATABASE_URL=postgres://x',
    );
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=');
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
    // A non-sensitive assignment is left intact (no over-redaction of ordinary config).
    expect(out).toContain('DATABASE_URL=postgres://x');
  });

  test('masks a colon-separated sensitive assignment (header/YAML shape)', () => {
    const out = redactSecrets('x-api-token: 9f8e7d6c5b4a39281706abcdEF');
    expect(out).toContain('x-api-token:');
    expect(out).not.toContain('9f8e7d6c5b4a39281706abcdEF');
  });

  test('conservative high-entropy fallback catches an unprefixed mixed token', () => {
    const token = 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA';
    expect(redactSecrets(`weird ${token} tail`)).toBe(`weird ${REDACTED} tail`);
  });

  test('does NOT mask ordinary commands or paths (no over-redaction)', () => {
    // Short, structure-carrying command lines must round-trip byte-for-byte.
    expect(redactSecrets('bun test --coverage')).toBe('bun test --coverage');
    expect(
      redactSecrets('cd /Users/dev/projects/nightcore/apps/desktop/src-tauri'),
    ).toBe('cd /Users/dev/projects/nightcore/apps/desktop/src-tauri');
    // The `--no-verify` flag the anti-gaming ledger sweep keys off MUST survive
    // redaction (it targets secret VALUES, never flags) — this is load-bearing for
    // the Rust hook-bypass detector that reads `input_digest`.
    expect(redactSecrets('git commit -m "wip" --no-verify')).toContain(
      '--no-verify',
    );
  });

  test('is total: empty string in, empty string out; never throws', () => {
    expect(redactSecrets('')).toBe('');
    expect(() => redactSecrets('a'.repeat(10_000))).not.toThrow();
  });
});

describe('SENSITIVE_EXPORT_EXCLUDE / isSensitiveExportName', () => {
  test('flags secret-bearing names case-insensitively', () => {
    for (const name of [
      'API_TOKEN',
      'token',
      'AWS_SECRET_ACCESS_KEY',
      'password',
      'DB_PASSWORD',
      'private_key',
      'GITHUB_TOKEN',
      'Authorization',
      'session_id',
      'openai_api_key',
    ]) {
      expect(isSensitiveExportName(name)).toBe(true);
    }
  });

  test('does NOT flag ordinary config names', () => {
    for (const name of ['DATABASE_URL', 'PORT', 'NODE_ENV', 'user', 'path', '']) {
      expect(isSensitiveExportName(name)).toBe(false);
    }
  });

  test('the denylist is non-empty (a report writer has something to consult)', () => {
    expect(SENSITIVE_EXPORT_EXCLUDE.length).toBeGreaterThan(0);
  });
});
