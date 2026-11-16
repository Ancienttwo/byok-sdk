import { describe, expect, it } from 'vitest';

import {
  ExecutionTargetSchema,
  TaskOfferPayloadSchema,
} from '../index';

const OFFER = {
  instruction: 'hello',
  agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
  session: { mode: 'resume', sessionRef: 'session-1' },
} as const;

const PROFILE = {
  profileRef: 'profile-1',
  profileRevision: '1',
  profileHash: `sha256:${'c'.repeat(64)}`,
  modelId: 'gpt-5.2',
  requiredCapabilities: ['image-input'],
} as const;

describe('ExecutionTargetSchema (wire v7 offer target)', () => {
  it.each([
    { lane: 'auto' },
    { lane: 'runtime', runtimeId: 'codex' },
    { lane: 'subscription', runtimeId: 'claude', modelId: 'opus' },
    { lane: 'byok', runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-5.2' },
    { lane: 'byok-profile', runtimeId: 'pi', providerProfile: PROFILE },
    { lane: 'harness', harnessId: 'grok' },
  ])('round-trips the $lane lane on task.offer', (target) => {
    expect(ExecutionTargetSchema.parse(target)).toEqual(target);
    expect(TaskOfferPayloadSchema.parse({ ...OFFER, target })).toMatchObject({ target });
  });

  it.each([
    { lane: 'subscription', runtimeId: 'pi', modelId: 'gpt-5.2' },
    { lane: 'byok', runtimeId: 'codex', providerId: 'openai', modelId: 'gpt-5.2' },
    { lane: 'byok-profile', runtimeId: 'claude', providerProfile: PROFILE },
    // v7 drops the subscription providerId: a vendor CLI owns its provider.
    { lane: 'subscription', runtimeId: 'claude', providerId: null, modelId: 'opus' },
    { lane: 'auto', runtimeId: 'pi' },
    { lane: 'runtime', runtimeId: 'grok' },
  ])('refuses a cross-lane or widened target %#', (target) => {
    expect(ExecutionTargetSchema.safeParse(target).success).toBe(false);
  });

  it('requires a target on task.offer', () => {
    expect(TaskOfferPayloadSchema.safeParse(OFFER).success).toBe(false);
  });

  it.each([
    ['runtime', { runtime: 'codex' }],
    ['harnessId', { harnessId: 'grok' }],
    ['dispatchSelection', { dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-5.2' } }],
  ])('refuses the v6 selector %s, alone or beside a target', (_key, selector) => {
    expect(TaskOfferPayloadSchema.safeParse({ ...OFFER, ...selector }).success).toBe(false);
    expect(TaskOfferPayloadSchema.safeParse({ ...OFFER, target: { lane: 'auto' }, ...selector }).success).toBe(false);
  });
});
