import { describe, expect, it } from 'vitest';
import { ClaimedExecutorSchema, ExecutionTargetSchema, HarnessInventorySchema, harnessSupportsTarget, TaskOfferPayloadSchema } from '../index';

const OFFER = {
  instruction: 'hello',
  agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
  session: { mode: 'resume', sessionRef: 'session-1' },
} as const;

const PROFILE = {
  profileRef: 'local-profile',
  profileRevision: '1',
  profileHash: `sha256:${'c'.repeat(64)}`,
  requiredCapabilities: ['image-input'],
};

const target = (harnessId: string, selection: object) => ({ lane: 'harness', harnessId, selection });

it.each([
  { lane: 'auto' },
  target('codex', { mode: 'device-default' }),
  target('grok', { mode: 'adapter-model', modelId: 'grok-code' }),
  target('opencode', { mode: 'adapter-model' }),
  target('dsh', { mode: 'byok', providerId: 'deepseek' }),
  target('claude', { mode: 'subscription', modelId: 'opus' }),
  target('agy', { mode: 'byok', providerId: 'google', modelId: 'gemini' }),
  target('pi', { mode: 'byok-profile', providerProfile: PROFILE }),
  target('pi', { mode: 'byok-profile', providerProfile: PROFILE, modelId: 'org/model:high' }),
])('round-trips target %j', value => {
  expect(ExecutionTargetSchema.parse(value)).toEqual(value);
  expect(TaskOfferPayloadSchema.parse({ ...OFFER, target: value }).target).toEqual(value);
});

it.each([
  { lane: 'runtime', runtimeId: 'codex' },
  { lane: 'subscription', runtimeId: 'claude', modelId: 'opus' },
  { lane: 'byok', runtimeId: 'pi', providerId: 'local-profile', modelId: 'gpt-5.2' },
  { lane: 'byok-profile', runtimeId: 'pi', providerProfile: PROFILE },
  { lane: 'harness', harnessId: 'grok' },
  { lane: 'harness', harnessId: 'grok', modelId: 'grok-code', selection: { mode: 'device-default' } },
  { lane: 'auto', selection: { mode: 'device-default' } },
  target('codex', { mode: 'device-default', modelId: 'gpt' }),
  target('grok', { mode: 'adapter-model', modelId: 'grok-code', providerId: 'xai' }),
  target('claude', { mode: 'subscription', modelId: 'opus', providerId: null }),
  target('agy', { mode: 'byok', providerId: 'google', modelId: 'gemini', providerProfile: PROFILE }),
  target('pi', { mode: 'byok-profile', providerProfile: { ...PROFILE, modelId: 'gpt' } }),
])('refuses a legacy or widened target %j', value => {
  expect(ExecutionTargetSchema.safeParse(value).success).toBe(false);
});

it('requires a target on task.offer', () => {
  expect(TaskOfferPayloadSchema.safeParse(OFFER).success).toBe(false);
});

it.each([
  ['runtime', { runtime: 'codex' }],
  ['harnessId', { harnessId: 'grok' }],
  ['dispatchSelection', { dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-5.2' } }],
])('refuses the v6 selector %s, alone or beside a target', (_key, legacy) => {
  expect(TaskOfferPayloadSchema.safeParse({ ...OFFER, ...legacy }).success).toBe(false);
  expect(TaskOfferPayloadSchema.safeParse({ ...OFFER, target: { lane: 'auto' }, ...legacy }).success).toBe(false);
});

describe('executor admission', () => {
  const [agy] = HarnessInventorySchema.parse([{ id: 'agy', capabilities: { selectionModes: ['byok'], byokProviderId: 'google', effort: false } }]);
  const google = { lane: 'harness', harnessId: 'agy', selection: { mode: 'byok', providerId: 'google', modelId: 'gemini' } } as const;

  it('validates defaults against the advertised model-bearing modes', () => {
    const item = { id: 'fixture', capabilities: { selectionModes: ['adapter-model'], effort: true } };
    for (const defaultModelModes of [['byok'], ['adapter-model', 'adapter-model']]) {
      expect(HarnessInventorySchema.safeParse([{ ...item, capabilities: { ...item.capabilities, defaultModelModes } }]).success).toBe(false);
    }
    expect(HarnessInventorySchema.safeParse([{ ...item, capabilities: { ...item.capabilities, defaultModelModes: ['adapter-model'] } }]).success).toBe(true);
  });

  it('admits the announced BYOK provider', () => {
    expect(harnessSupportsTarget(agy!, google)).toBe(true);
  });

  it('rejects auto for a BYOK-only executor', () => {
    expect(harnessSupportsTarget(agy!, { lane: 'auto' })).toBe(false);
  });

  it('admits auto for a device-default executor', () => {
    expect(harnessSupportsTarget({ id: 'codex', capabilities: { selectionModes: ['device-default'], effort: true } }, { lane: 'auto' })).toBe(true);
  });

  it('rejects a different executor id', () => {
    expect(harnessSupportsTarget(agy!, { ...google, harnessId: 'dsh' })).toBe(false);
  });

  it('rejects an unadvertised selection mode', () => {
    expect(harnessSupportsTarget(agy!, { ...google, selection: { mode: 'device-default' } })).toBe(false);
  });

  it('rejects a different provider id', () => {
    expect(harnessSupportsTarget(agy!, { ...google, selection: { ...google.selection, providerId: 'openai' } })).toBe(false);
  });

  it('rejects effort absent from the descriptor', () => {
    expect(harnessSupportsTarget(agy!, { ...google, effort: 'high' })).toBe(false);
  });

  it('requires both per-harness declarations when the Host allows a tier fallback', () => {
    const standard = { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } } as const;
    const fast = { ...standard, serviceTier: 'fast' };
    const fallback = { ...fast, serviceTierFallback: 'default' } as const;
    const [legacy, tier, both, fallbackOnly] = HarnessInventorySchema.parse([
      { id: 'legacy', capabilities: { selectionModes: ['device-default'], effort: true } },
      { id: 'tier', capabilities: { selectionModes: ['device-default'], effort: true, serviceTier: true } },
      { id: 'both', capabilities: { selectionModes: ['device-default'], effort: true, serviceTier: true, serviceTierFallback: true } },
      { id: 'fallback-only', capabilities: { selectionModes: ['device-default'], effort: true, serviceTier: false, serviceTierFallback: true } },
    ]).map(item => ({ ...item, id: 'codex' }));
    expect(harnessSupportsTarget(legacy!, standard)).toBe(true);
    expect(harnessSupportsTarget(legacy!, fast)).toBe(false);
    expect(harnessSupportsTarget(tier!, fast)).toBe(true);
    expect(harnessSupportsTarget(tier!, fallback)).toBe(false);
    expect(harnessSupportsTarget(both!, fallback)).toBe(true);
    expect(harnessSupportsTarget(fallbackOnly!, fallback)).toBe(false);
  });

  it('rejects a BYOK declaration without a provider id', () => {
    expect(HarnessInventorySchema.safeParse([{ id: 'agy', capabilities: { selectionModes: ['byok'], effort: false } }]).success).toBe(false);
  });

  it('rejects a provider id without a BYOK declaration', () => {
    expect(HarnessInventorySchema.safeParse([{ id: 'agy', capabilities: { selectionModes: [], byokProviderId: 'google', effort: false } }]).success).toBe(false);
  });
});

it('a claim carries only one executor id', () => {
  expect(ClaimedExecutorSchema.parse({ id: 'pi' })).toEqual({ id: 'pi' });
  expect(ClaimedExecutorSchema.safeParse({ id: 'pi', modelId: 'model' }).success).toBe(false);
  expect(ClaimedExecutorSchema.safeParse({ kind: 'runtime', runtimeId: 'pi' }).success).toBe(false);
});
