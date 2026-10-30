/**
 * Presence carries the conn.hello capability matrix (#1103): a Host reads
 * each runtime's capabilities before dispatch, through the same store read it
 * already uses for presence. Core keeps its own copy of the shape, because
 * core does not depend on the protocol package; the type check below holds
 * the two equal.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PresenceRuntimeCapabilities } from '@byok-sdk/core';
import type { RuntimeCapabilities } from '@byok-sdk/protocol';
import { createHarness, TENANT_A } from './support/harness';

const MATRIX = {
  steer: false, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true,
  toolAuthorizationAuto: true, durablePi: false, preparedLane: false,
  isolation: { userContext: true, userMcpServers: true, sessionPersistence: true },
} as const;

describe('presence capability matrix', () => {
  it('core keeps the protocol capability shape', () => {
    // Core's copy is readonly; the zod-inferred protocol type is not.
    expectTypeOf<Required<Omit<PresenceRuntimeCapabilities, 'isolation'>>>()
      .toEqualTypeOf<Readonly<Required<Omit<RuntimeCapabilities, 'isolation'>>>>();
    expectTypeOf<Required<NonNullable<PresenceRuntimeCapabilities['isolation']>>>()
      .toEqualTypeOf<Readonly<Required<NonNullable<RuntimeCapabilities['isolation']>>>>();
  });

  it('stores and reads back every matrix field, drops unknown keys, and leaves an unreported matrix unknown', async () => {
    const harness = createHarness({ presenceMinimumIntervalMs: 0 });
    const device = await harness.pairDevice(TENANT_A);
    const response = await harness.request('/byok/presence', {
      method: 'PUT',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'online',
        runtimes: [
          { id: 'claude', version: '2.1.312', capabilities: { ...MATRIX, futureFlag: true, isolation: { ...MATRIX.isolation, futureSource: true } } },
          { id: 'codex', version: '0.165.0' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const hint = await harness.core.presence.read(TENANT_A, device.deviceId);
    expect(hint?.runtimes).toEqual([
      { id: 'claude', version: '2.1.312', capabilities: MATRIX },
      { id: 'codex', version: '0.165.0' },
    ]);
    expect(Object.isFrozen(hint?.runtimes?.[0]?.capabilities?.isolation)).toBe(true);
  });
});
