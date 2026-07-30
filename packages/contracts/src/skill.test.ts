/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { TaskKindSchema } from './config.js';
import { ProviderCapabilitiesSchema } from './provider.js';
import {
  diagnoseSkillDescriptor,
  ProviderCapabilityFlagSchema,
  type SkillDescriptor,
  SkillDescriptorSchema,
  SkillIdSchema,
} from './skill.js';
import { WRITE_TOOL_NAMES } from './tools.js';

/** A coherent read-only skill — the `decompose`-shaped baseline every case below
 *  mutates one field of, so each test isolates exactly one invariant. */
const READ_ONLY: SkillDescriptor = SkillDescriptorSchema.parse({
  id: 'decompose',
  label: 'Decompose',
  summary: 'Split a goal into sub-tasks',
  source: 'builtin',
  userSelectable: true,
  agent: {
    systemPromptAppend: 'You are a planning agent.',
    toolPolicy: { deny: [...WRITE_TOOL_NAMES, 'WebFetch', 'WebSearch'] },
    defaultAutonomy: null,
    structuredOutput: true,
  },
  orchestration: {
    allocatesWorktree: false,
    verifyAfter: false,
    writesCode: false,
  },
  requiredCapabilities: ['supportsStructuredOutput'],
});

/** A coherent write-capable skill — the `build`-shaped baseline. */
const WRITE_CAPABLE: SkillDescriptor = SkillDescriptorSchema.parse({
  id: 'build',
  label: 'Build',
  summary: 'Write code in an isolated worktree, then verify',
  source: 'builtin',
  userSelectable: true,
  agent: {
    toolPolicy: { deny: ['WebFetch', 'WebSearch'] },
    defaultAutonomy: null,
    structuredOutput: false,
  },
  orchestration: { allocatesWorktree: true, verifyAfter: true, writesCode: true },
});

describe('SkillDescriptorSchema', () => {
  test('a skill id is exactly the TaskKind vocabulary (stage 2 widens it here)', () => {
    expect(SkillIdSchema.options).toEqual(TaskKindSchema.options);
    expect(SkillIdSchema.safeParse('build').success).toBe(true);
    // Stage 2 (slug ids + quarantine-on-unknown) is what opens this; until then a
    // descriptor id the wire cannot carry must not parse.
    expect(SkillIdSchema.safeParse('my-custom-skill').success).toBe(false);
  });

  test('posture fields are required; content fields default to empty', () => {
    // Governance facts have no implicit `false`: omitting one is a parse error.
    const missingPosture = {
      ...WRITE_CAPABLE,
      orchestration: { allocatesWorktree: true, verifyAfter: true },
    };
    expect(SkillDescriptorSchema.safeParse(missingPosture).success).toBe(false);

    // Content fields are ergonomic for a hand-authored skill file — an omitted tool
    // policy is "no restrictions declared" (the `research` posture), a real answer.
    expect(WRITE_CAPABLE.agent.systemPromptAppend).toBe('');
    expect(WRITE_CAPABLE.agent.toolPolicy.allow).toEqual([]);
    expect(WRITE_CAPABLE.requiredCapabilities).toEqual([]);
    const noToolPolicy = SkillDescriptorSchema.parse({
      ...WRITE_CAPABLE,
      agent: { defaultAutonomy: null, structuredOutput: false },
    });
    expect(noToolPolicy.agent.toolPolicy).toEqual({ allow: [], deny: [] });
  });

  test('`source` distinguishes a builtin from a (future) user-authored skill', () => {
    expect(SkillDescriptorSchema.safeParse({ ...READ_ONLY, source: 'user' }).success).toBe(
      false,
    );
  });

  test('rejects a Claude-native permission mode in the neutral autonomy field', () => {
    // The descriptor speaks `AutonomyLevel`; `dontAsk` is an SDK mode the engine
    // lowers to at its own boundary, and must not leak into the contract.
    const sdkMode = {
      ...READ_ONLY,
      agent: { ...READ_ONLY.agent, defaultAutonomy: 'dontAsk' },
    };
    expect(SkillDescriptorSchema.safeParse(sdkMode).success).toBe(false);
    expect(
      SkillDescriptorSchema.safeParse({
        ...READ_ONLY,
        agent: { ...READ_ONLY.agent, defaultAutonomy: 'auto-accept' },
      }).success,
    ).toBe(true);
  });
});

describe('ProviderCapabilityFlagSchema', () => {
  test('names exactly the boolean flags of ProviderCapabilities', () => {
    // Read the boolean-valued keys off the schema itself: a flag added to
    // `ProviderCapabilities` and not listed here would let a skill declare a
    // requirement the capability contract cannot answer.
    const booleanKeys = Object.entries(ProviderCapabilitiesSchema.shape)
      .filter(([, schema]) => schema.safeParse(true).success)
      .map(([key]) => key)
      .sort();
    expect([...ProviderCapabilityFlagSchema.options].sort()).toEqual(booleanKeys);
  });

  test('rejects a non-flag capability field', () => {
    // `costTelemetry` is a descriptor field, not a boolean flag — requiring it
    // would be meaningless.
    expect(ProviderCapabilityFlagSchema.safeParse('costTelemetry').success).toBe(false);
  });
});

describe('diagnoseSkillDescriptor', () => {
  test('coherent builtin-shaped descriptors report nothing', () => {
    expect(diagnoseSkillDescriptor(READ_ONLY)).toEqual([]);
    expect(diagnoseSkillDescriptor(WRITE_CAPABLE)).toEqual([]);
  });

  test('a read-only skill that leaves a write tool callable is an error', () => {
    const leaky: SkillDescriptor = {
      ...READ_ONLY,
      agent: {
        ...READ_ONLY.agent,
        // Denies four of the five write tools — the omission is the whole point.
        toolPolicy: { allow: [], deny: WRITE_TOOL_NAMES.filter((t) => t !== 'ApplyPatch') },
      },
    };
    const [issue, ...rest] = diagnoseSkillDescriptor(leaky);
    expect(rest).toEqual([]);
    expect(issue.code).toBe('read-only-permits-writes');
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('ApplyPatch');
  });

  test('verification without writes is an error; writes without a worktree warn', () => {
    const verifiedReadOnly = {
      ...READ_ONLY,
      orchestration: { ...READ_ONLY.orchestration, verifyAfter: true },
    };
    expect(diagnoseSkillDescriptor(verifiedReadOnly).map((d) => d.code)).toEqual([
      'verify-without-writes',
    ]);

    const unisolated = {
      ...WRITE_CAPABLE,
      orchestration: { ...WRITE_CAPABLE.orchestration, allocatesWorktree: false },
    };
    const [warning] = diagnoseSkillDescriptor(unisolated);
    expect(warning.code).toBe('writes-without-worktree');
    // Never blocks authoring: a main-mode run is a real (if unisolated) posture.
    expect(warning.severity).toBe('warning');
  });

  test('a tool that is both allowed and denied is an error (denial wins)', () => {
    const contradictory = {
      ...WRITE_CAPABLE,
      agent: {
        ...WRITE_CAPABLE.agent,
        toolPolicy: { allow: ['WebFetch'], deny: ['WebFetch', 'WebSearch'] },
      },
    };
    expect(diagnoseSkillDescriptor(contradictory).map((d) => d.code)).toEqual([
      'contradictory-tool-policy',
    ]);
  });

  test('structured output must declare the capability it silently degrades without', () => {
    const undeclared = { ...READ_ONLY, requiredCapabilities: [] };
    expect(diagnoseSkillDescriptor(undeclared).map((d) => d.code)).toEqual([
      'undeclared-structured-output',
    ]);
  });

  test('collects every issue rather than stopping at the first', () => {
    const broken: SkillDescriptor = {
      ...READ_ONLY,
      agent: {
        ...READ_ONLY.agent,
        toolPolicy: { allow: ['Read'], deny: ['Read'] },
      },
      orchestration: { allocatesWorktree: false, verifyAfter: true, writesCode: false },
      requiredCapabilities: [],
    };
    expect(diagnoseSkillDescriptor(broken).map((d) => d.code).sort()).toEqual(
      [
        'contradictory-tool-policy',
        'read-only-permits-writes',
        'undeclared-structured-output',
        'verify-without-writes',
      ].sort(),
    );
  });
});
