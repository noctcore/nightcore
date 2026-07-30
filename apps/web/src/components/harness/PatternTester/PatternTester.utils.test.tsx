import { expect, test } from 'vitest';

import { compilePathRule, pathSegments, ruleProtects } from '@nightcore/contracts';

import type { PolicyProbeLists } from './PatternTester.types';
import { probeCommand, probeRead, probeTool, probeWrite } from './PatternTester.utils';

const LISTS: PolicyProbeLists = {
  protectedPaths: ['bun.lock', 'migrations/**'],
  denyReadPaths: ['.env*'],
  denyBashPatterns: ['--no-verify', '['],
  disallowedTools: ['WebSearch', 'mcp__acme__*'],
  askTools: ['WebFetch', 'WebSearch'],
};

const EMPTY: PolicyProbeLists = {
  protectedPaths: [],
  denyReadPaths: [],
  denyBashPatterns: [],
  disallowedTools: [],
  askTools: [],
};

test('a protected path denies the write and attributes the rule', () => {
  const verdict = probeWrite(LISTS, 'migrations/001_init.sql');
  expect(verdict.outcome).toBe('denied');
  expect(verdict.tier).toBe('protectedPaths');
  expect(verdict.pattern).toBe('migrations/**');
});

test('an uncovered path reports writable', () => {
  expect(probeWrite(LISTS, 'src/main.ts').outcome).toBe('allowed');
  expect(probeWrite(LISTS, 'src/main.ts').pattern).toBeNull();
});

test('the manifest is protected even with no author rules, and named as implicit', () => {
  const verdict = probeWrite(EMPTY, '.nightcore/harness.json');
  expect(verdict.outcome).toBe('denied');
  expect(verdict.tier).toBe('implicit self-protection');
});

test('read denial is a separate channel from write protection', () => {
  expect(probeRead(LISTS, '.env.local').outcome).toBe('denied');
  // Denied for reads, but nothing protects it from a write.
  expect(probeWrite(LISTS, '.env.local').outcome).toBe('allowed');
  // Protected from writes, but readable.
  expect(probeRead(LISTS, 'bun.lock').outcome).toBe('allowed');
});

test('an empty probe never reports a denial', () => {
  expect(probeWrite(LISTS, '   ').outcome).toBe('allowed');
  expect(probeRead(LISTS, '').outcome).toBe('allowed');
  expect(probeCommand(LISTS, '  ').outcome).toBe('allowed');
  expect(probeTool(LISTS, '').outcome).toBe('allowed');
});

test('a matching bash pattern denies the command and names the pattern', () => {
  const verdict = probeCommand(LISTS, 'git commit --no-verify -m wip');
  expect(verdict.outcome).toBe('denied');
  expect(verdict.pattern).toBe('--no-verify');
});

test('an uncompilable bash pattern is skipped, exactly as the engine skips it', () => {
  // `[` never compiles, so it enforces nothing — and must not match anything here.
  expect(probeCommand(LISTS, 'echo [').outcome).toBe('allowed');
});

test('bash matching is case-sensitive, like the gate', () => {
  expect(probeCommand(LISTS, 'git commit --NO-VERIFY').outcome).toBe('allowed');
});

test('deny beats ask for a tool in both tiers', () => {
  const verdict = probeTool(LISTS, 'WebSearch');
  expect(verdict.outcome).toBe('denied');
  expect(verdict.tier).toBe('disallowedTools');
});

test('an ask-tier tool escalates rather than denies', () => {
  const verdict = probeTool(LISTS, 'WebFetch');
  expect(verdict.outcome).toBe('ask');
  expect(verdict.tier).toBe('askTools');
});

test('an mcp server glob gates every tool of that server, and attributes the glob', () => {
  const verdict = probeTool(LISTS, 'mcp__acme__push');
  expect(verdict.outcome).toBe('denied');
  expect(verdict.pattern).toBe('mcp__acme__*');
  expect(probeTool(LISTS, 'mcp__other__push').outcome).toBe('allowed');
});

test('the tester agrees with the shared matcher on a case-variant path', () => {
  // Guards the whole point of #400's tester: the verdict must be the matcher's.
  const rule = compilePathRule('migrations/**')!;
  expect(ruleProtects(rule, pathSegments('Migrations/001.sql'))).toBe(true);
  expect(probeWrite(LISTS, 'Migrations/001.sql').outcome).toBe('denied');
});
