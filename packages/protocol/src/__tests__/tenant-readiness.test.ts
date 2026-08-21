import { describe, expect, it } from 'vitest';
import { ConnHelloPayloadSchema } from '../messages';
import { PresencePublishRequestSchema } from '../http-api';

describe('U3 frozen readiness identity projection', () => {
  it('retains the U4a release version in the handshake payload', () => {
    const parsed = ConnHelloPayloadSchema.parse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'product-1',
      clientVersion: '0.4.2',
    });

    expect(parsed.clientVersion).toBe('0.4.2');
  });

  it('keeps unknown runtime/auth facts omitted instead of inventing them', () => {
    const parsed = PresencePublishRequestSchema.parse({
      level: 'online',
      clientVersion: '0.4.2',
      runtimes: [{ id: 'pi' }],
    });

    expect(parsed).toEqual({
      level: 'online',
      clientVersion: '0.4.2',
      runtimes: [{ id: 'pi' }],
    });
  });

  it('rejects unsafe or unbounded protocol version numbers', () => {
    expect(() =>
      ConnHelloPayloadSchema.parse({
        protocolVersions: [Number.MAX_SAFE_INTEGER + 1],
        capabilities: [],
        deviceId: 'device-1',
        productId: 'product-1',
      }),
    ).toThrow();
    expect(() =>
      PresencePublishRequestSchema.parse({
        level: 'online',
        protocolVersions: [2_147_483_648],
      }),
    ).toThrow();
  });

  it('bounds every presence string, array, and numeric observation', () => {
    const valid = { level: 'online' as const };
    expect(() => PresencePublishRequestSchema.parse({ ...valid, detail: 'd'.repeat(513) })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({ ...valid, clientVersion: 'v'.repeat(129) })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({
      ...valid,
      configuredToolsets: Array.from({ length: 65 }, (_, index) => `tool-${String(index)}`),
    })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({ ...valid, protocolVersions: [1.5] })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({ ...valid, protocolVersions: Array(17).fill(1) })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({
      ...valid,
      runtimes: [{ id: 'pi', version: 'v'.repeat(129) }],
    })).toThrow();
    expect(() => PresencePublishRequestSchema.parse({
      ...valid,
      runtimes: Array.from({ length: 17 }, () => ({ id: 'pi' })),
    })).toThrow();
  });
});
