import { describe, expect, it } from 'vitest';
import { HarnessIdSchema, PresencePublishRequestSchema, RuntimeVersionPolicyProjectionSchema } from '../index';
import { ConnHelloPayloadSchema, RuntimeUnavailableEntrySchema } from '../messages';

const helloBase = {
  protocolVersions: [8], capabilities: [], deviceId: 'device-1', productId: 'product-1', harnesses: [],
};
const capabilities = { selectionModes: ['device-default'], effort: false };
const harnesses = [
  { id: 'claude', version: '2.1.312', capabilities, versionPolicy: { state: 'allow', qualifiedVersion: '2.1.312' } },
  { id: 'codex', version: '0.160.0', capabilities, versionPolicy: { state: 'warn' } },
  { id: 'grok', version: '1.0.52', capabilities, authPresent: true },
];
const unavailable = Array.from({ length: 65 }, (_, index) => ({
  id: HarnessIdSchema.parse(`harness-${index}`), cause: 'not_installed', retryable: true,
}));

describe('executor discovery on conn.hello and presence', () => {
  it('retains observed versions, policies and authentication fields', () => {
    expect(ConnHelloPayloadSchema.parse({ ...helloBase, harnesses }).harnesses).toEqual(harnesses);
    expect(PresencePublishRequestSchema.parse({ level: 'online', harnesses }).harnesses).toEqual(harnesses);
  });

  it('keeps a block verdict as diagnostic evidence', () => {
    expect(RuntimeVersionPolicyProjectionSchema.parse({ state: 'block', qualifiedVersion: '1.2.3' })).toEqual({ state: 'block', qualifiedVersion: '1.2.3' });
  });

  it('retains an unrecognized unavailable cause', () => {
    const runtimeUnavailable = [{ id: 'grok', cause: 'invented_cause', retryable: false }];
    expect(ConnHelloPayloadSchema.parse({ ...helloBase, runtimeUnavailable }).runtimeUnavailable).toEqual(runtimeUnavailable);
    expect(PresencePublishRequestSchema.parse({ level: 'online', runtimeUnavailable }).runtimeUnavailable).toEqual(runtimeUnavailable);
  });

  it('accepts 64 unavailable entries in hello and presence', () => {
    const runtimeUnavailable = unavailable.slice(0, 64);
    expect(ConnHelloPayloadSchema.parse({ ...helloBase, runtimeUnavailable }).runtimeUnavailable).toEqual(runtimeUnavailable);
    expect(PresencePublishRequestSchema.parse({ level: 'online', runtimeUnavailable }).runtimeUnavailable).toEqual(runtimeUnavailable);
  });

  it('rejects duplicate unavailable identities', () => {
    const runtimeUnavailable = [unavailable[0], unavailable[0]];
    expect(() => ConnHelloPayloadSchema.parse({ ...helloBase, runtimeUnavailable })).toThrow(/duplicate runtime-unavailable/);
  });

  it('rejects 65 unavailable entries in hello and presence', () => {
    expect(ConnHelloPayloadSchema.safeParse({ ...helloBase, runtimeUnavailable: unavailable }).success).toBe(false);
    expect(PresencePublishRequestSchema.safeParse({ level: 'online', runtimeUnavailable: unavailable }).success).toBe(false);
  });

  it('rejects an invalid verdict or a missing retry hint', () => {
    expect(() => RuntimeVersionPolicyProjectionSchema.parse({ state: 'invented' })).toThrow();
    expect(() => RuntimeUnavailableEntrySchema.parse({ id: 'pi', cause: 'not_installed' })).toThrow(/retryable/);
  });

  it('strips unknown presence fields while keeping absence of observations', () => {
    expect(PresencePublishRequestSchema.parse({ level: 'online', futureDiscovery: { state: 'allow' } })).toEqual({ level: 'online' });
  });
});
