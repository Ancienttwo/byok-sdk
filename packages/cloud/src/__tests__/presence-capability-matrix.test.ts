/**
 * Presence carries the conn.hello capability matrix (#1103): a Host reads
 * each runtime's capabilities before dispatch, through the same store read it
 * already uses for presence. Core keeps its own copy of the shape, because
 * core does not depend on the protocol package; the type check below holds
 * the two equal.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PresenceRuntimeCapabilities } from '@byok-sdk/core';
import type { HarnessInfo } from '@byok-sdk/protocol';
import { createHarness, TENANT_A } from './support/harness';

const MATRIX = {
  steer: false, images: true, resume: true, approvalInteractive: false, mcpToolsets: true, skills: true, messageDraft: true,
  selectionModes: ['device-default', 'adapter-model'], defaultModelModes: ['adapter-model'], effort: false,
  serviceTier: true, serviceTierFallback: true,
  toolAuthorizationAuto: true, durableLane: false, preparedLane: false,
  isolation: { userInstructions: true, userOutputStyle: false, userMemory: true, userSkills: false, userHookContext: true, userMcpServers: true, sessionPersistence: true },
} as const;

describe('presence capability matrix', () => {
  it('core keeps the protocol capability shape', () => {
    // Core's copy is readonly; the zod-inferred protocol type is not.
    expectTypeOf<Required<Omit<PresenceRuntimeCapabilities, 'isolation' | 'selectionModes' | 'defaultModelModes'>>>()
      .toEqualTypeOf<Readonly<Required<Omit<HarnessInfo['capabilities'], 'isolation' | 'selectionModes' | 'defaultModelModes'>>>>();
    expectTypeOf<PresenceRuntimeCapabilities['defaultModelModes']>()
      .toEqualTypeOf<Readonly<NonNullable<HarnessInfo['capabilities']['defaultModelModes']>> | undefined>();
    expectTypeOf<Required<NonNullable<PresenceRuntimeCapabilities['isolation']>>>()
      .toEqualTypeOf<Readonly<Required<NonNullable<HarnessInfo['capabilities']['isolation']>>>>();
  });

  it('stores and reads back every matrix field, drops unknown keys, and preserves each executor’s selection modes', async () => {
    const harness = createHarness({ presenceMinimumIntervalMs: 0 });
    const device = await harness.pairDevice(TENANT_A);
    const response = await harness.request('/byok/presence', {
      method: 'PUT',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'online',
        harnesses: [
          { id: 'claude', version: '2.1.326', capabilities: { ...MATRIX, futureFlag: true, isolation: { ...MATRIX.isolation, futureSource: true } } },
          { id: 'codex', version: '0.165.0', capabilities: { selectionModes: ['subscription'], effort: true } },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const hint = await harness.core.presence.read(TENANT_A, device.deviceId);
    expect(hint?.harnesses).toEqual([
      { id: 'claude', version: '2.1.326', capabilities: MATRIX },
      { id: 'codex', version: '0.165.0', capabilities: { selectionModes: ['subscription'], effort: true } },
    ]);
    expect(Object.isFrozen(hint?.harnesses?.[0]?.capabilities?.isolation)).toBe(true);
  });
});
