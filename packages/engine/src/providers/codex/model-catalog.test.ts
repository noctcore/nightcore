/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  CODEX_MODELS_FALLBACK,
  CODEX_UNAVAILABLE_HINT,
  listCodexModels,
  parseModelList,
  probeCodexCli,
} from './model-catalog.js';

const tempFiles: string[] = [];

function writeTempScript(body: string): string {
  const file = path.join(
    os.tmpdir(),
    `nightcore-codex-fake-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  fs.writeFileSync(file, body, { mode: 0o755 });
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe('parseModelList', () => {
  test('returns an empty list when data is missing or not an array', () => {
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList({ data: null })).toEqual([]);
    expect(parseModelList({ data: 'nope' })).toEqual([]);
  });

  test('falls back to id when model is absent and drops empty strings', () => {
    expect(
      parseModelList({
        data: [
          { id: 'gpt-from-id', displayName: 'From id', description: 'via id' },
          { id: '', model: '', displayName: 'Empty' },
          { model: 'gpt-named', supportedReasoningEfforts: 'not-an-array' },
        ],
      }),
    ).toEqual([
      {
        providerId: 'codex',
        value: 'gpt-from-id',
        displayName: 'From id',
        description: 'via id',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
      {
        providerId: 'codex',
        value: 'gpt-named',
        displayName: 'gpt-named',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  test('keeps only known effort levels and dedupes them', () => {
    expect(
      parseModelList({
        data: [
          {
            model: 'gpt-5.5',
            supportedReasoningEfforts: [
              { reasoningEffort: 'high' },
              { reasoningEffort: 'high' },
              { reasoningEffort: 'max' },
              { reasoningEffort: 'minimal' },
              { reasoningEffort: 12 },
              {},
            ],
          },
        ],
      }),
    ).toEqual([
      {
        providerId: 'codex',
        value: 'gpt-5.5',
        displayName: 'gpt-5.5',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
      },
    ]);
  });
});

describe('probeCodexCli', () => {
  function withEnv(codexPath: string | undefined, run: () => void): void {
    const prevAgent = process.env.NIGHTCORE_AGENT_PATH;
    const prevCodex = process.env.NIGHTCORE_CODEX_PATH;
    delete process.env.NIGHTCORE_AGENT_PATH;
    if (codexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
    else process.env.NIGHTCORE_CODEX_PATH = codexPath;
    try {
      run();
    } finally {
      if (prevAgent === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = prevAgent;
      if (prevCodex === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = prevCodex;
    }
  }

  test('reports unavailable with the specific reason when an override is missing', () => {
    withEnv('/definitely/missing/nightcore-codex-probe', () => {
      const status = probeCodexCli();
      expect(status.ok).toBe(false);
      expect(status.message).toContain(
        '/definitely/missing/nightcore-codex-probe',
      );
    });
  });

  test('reports available for an existing override binary', () => {
    // Any existing executable satisfies the pure existence check.
    withEnv(process.execPath, () => {
      expect(probeCodexCli()).toEqual({ ok: true });
    });
  });

  test('exposes an actionable install/sign-in hint constant', () => {
    expect(CODEX_UNAVAILABLE_HINT).toContain('codex login');
    expect(CODEX_UNAVAILABLE_HINT).toContain('NIGHTCORE_CODEX_PATH');
  });
});

describe('listCodexModels', () => {
  test('returns the static fallback when the binary override is invalid', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    process.env.NIGHTCORE_CODEX_PATH = '/definitely/missing/nightcore-codex-catalog';
    delete process.env.NIGHTCORE_AGENT_PATH;
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    try {
      const models = await listCodexModels({
        warn: (message, fields) => warnings.push({ message, fields }),
      } as never);
      expect(models).toEqual(CODEX_MODELS_FALLBACK);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe('codex model catalog binary override invalid');
    } finally {
      if (previousAgentPath === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      if (previousCodexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
    }
  });

  test('returns the static fallback when the app-server exits before answering', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    const script = writeTempScript(`#!/usr/bin/env node
process.exit(1);
`);
    process.env.NIGHTCORE_CODEX_PATH = script;
    delete process.env.NIGHTCORE_AGENT_PATH;
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    try {
      const models = await listCodexModels({
        warn: (message, fields) => warnings.push({ message, fields }),
      } as never);
      expect(models).toEqual(CODEX_MODELS_FALLBACK);
      expect(warnings[0]?.message).toBe(
        'codex app-server model/list failed; using fallback catalog',
      );
    } finally {
      if (previousAgentPath === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      if (previousCodexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
    }
  });

  test('parses a successful app-server model/list exchange', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    const script = writeTempScript(`#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }
  if (msg.method === 'model/list') {
    process.stdout.write(
      JSON.stringify({
        id: msg.id,
        result: {
          data: [
            {
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
              description: 'Live',
              supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }],
            },
          ],
        },
      }) + '\\n',
    );
  }
});
`);
    process.env.NIGHTCORE_CODEX_PATH = script;
    delete process.env.NIGHTCORE_AGENT_PATH;
    try {
      const models = await listCodexModels();
      expect(models).toEqual([
        {
          providerId: 'codex',
          value: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: 'Live',
          supportsEffort: true,
          supportedEffortLevels: ['xhigh'],
        },
      ]);
    } finally {
      if (previousAgentPath === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      if (previousCodexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
    }
  });

  test('falls back when model/list returns an empty catalog', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    const script = writeTempScript(`#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }
  if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [] } }) + '\\n');
  }
});
`);
    process.env.NIGHTCORE_CODEX_PATH = script;
    delete process.env.NIGHTCORE_AGENT_PATH;
    try {
      await expect(listCodexModels()).resolves.toEqual(CODEX_MODELS_FALLBACK);
    } finally {
      if (previousAgentPath === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      if (previousCodexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
    }
  });

  test('retries a transient app-server blip and recovers the live catalog (issue #252)', async () => {
    const previousAgentPath = process.env.NIGHTCORE_AGENT_PATH;
    const previousCodexPath = process.env.NIGHTCORE_CODEX_PATH;
    // The script exits 1 on its FIRST spawn (the transient blip) and answers on the
    // retry — a sentinel file distinguishes the two, since each retry is a fresh
    // process. Previously this single blip would have degraded to the static
    // fallback; the retry must now recover the real catalog.
    const sentinel = path.join(
      os.tmpdir(),
      `nightcore-codex-retry-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.flag`,
    );
    tempFiles.push(sentinel);
    const script = writeTempScript(`#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SENTINEL = ${JSON.stringify(sentinel)};
if (!existsSync(SENTINEL)) {
  writeFileSync(SENTINEL, 'blipped');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }
  if (msg.method === 'model/list') {
    process.stdout.write(
      JSON.stringify({
        id: msg.id,
        result: {
          data: [
            {
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
              description: 'Recovered',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
        },
      }) + '\\n',
    );
  }
});
`);
    process.env.NIGHTCORE_CODEX_PATH = script;
    delete process.env.NIGHTCORE_AGENT_PATH;
    try {
      const models = await listCodexModels();
      expect(models).toEqual([
        {
          providerId: 'codex',
          value: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: 'Recovered',
          supportsEffort: true,
          supportedEffortLevels: ['high'],
        },
      ]);
    } finally {
      if (previousAgentPath === undefined) delete process.env.NIGHTCORE_AGENT_PATH;
      else process.env.NIGHTCORE_AGENT_PATH = previousAgentPath;
      if (previousCodexPath === undefined) delete process.env.NIGHTCORE_CODEX_PATH;
      else process.env.NIGHTCORE_CODEX_PATH = previousCodexPath;
    }
  });
});
