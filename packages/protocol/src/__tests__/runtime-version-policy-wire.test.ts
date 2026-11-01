import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConnHelloPayloadSchema,
  HarnessIdSchema,
  PresencePublishRequestSchema,
  RuntimeCapabilitiesSchema,
  RuntimeIdSchema,
  RuntimeUnavailableEntrySchema,
  RuntimeVersionPolicyProjectionSchema,
  readRuntimeUnavailableCause,
} from '../index';

/**
 * #1103 B2b wire shape: hello and presence carry strip-safe version-policy and
 * runtime-unavailable discovery data. These are behavioural tests of the
 * schemas, not type assertions: a value either round-trips exactly or is
 * rejected, and an older receiver's closed object drops the new keys.
 */

const helloBase = {
  protocolVersions: [5],
  capabilities: ['runtime-unavailable-cause'],
  deviceId: 'device-1',
  productId: 'product-1',
};

describe('conn.hello version policy projection (#1103 D8/D9)', () => {
  it('round-trips allow/warn/block runtimes and harnesses without inventing fields', () => {
    const payload = ConnHelloPayloadSchema.parse({
      ...helloBase,
      runtimes: [
        { id: 'claude', version: '2.1.312', versionPolicy: { state: 'allow', qualifiedVersion: '2.1.312' } },
        { id: 'codex', version: '0.160.0', versionPolicy: { state: 'warn' } },
        { id: 'pi', version: '1.4.0', versionPolicy: { state: 'block', qualifiedVersion: '1.4.0' } },
      ],
      harnesses: [
        { id: 'grok', capabilities: {}, versionPolicy: { state: 'warn', qualifiedVersion: '1.0.52' } },
      ],
      runtimeUnavailable: [
        { id: 'codex', cause: 'not_installed', retryable: true },
        { id: 'grok', cause: 'invented_cause', retryable: false },
      ],
    });
    expect(payload.runtimes?.map((runtime) => runtime.versionPolicy?.state)).toEqual(['allow', 'warn', 'block']);
    expect(payload.runtimes?.[1]?.versionPolicy).toEqual({ state: 'warn' });
    expect(payload.harnesses?.[0]?.versionPolicy).toEqual({ state: 'warn', qualifiedVersion: '1.0.52' });
    // The cause vocabulary is open: an unknown well-formed token is kept.
    expect(payload.runtimeUnavailable?.[1]).toEqual({ id: 'grok', cause: 'invented_cause', retryable: false });
    expect(readRuntimeUnavailableCause('invented_cause')).toEqual({ cause: 'unknown', reportedCause: 'invented_cause' });
  });

  it('treats an absent projection as unknown, never allow, and leaves an old payload byte-identical', () => {
    const old = {
      ...helloBase,
      runtimes: [{ id: 'claude', version: '2.1.312', authPresent: true }],
    };
    const parsed = ConnHelloPayloadSchema.parse(old);
    expect(parsed).toEqual(old);
    expect(parsed.runtimes?.[0]).not.toHaveProperty('versionPolicy');
    expect(parsed).not.toHaveProperty('runtimeUnavailable');
  });

  it('rejects duplicate and oversized runtimeUnavailable lists', () => {
    expect(() => ConnHelloPayloadSchema.parse({
      ...helloBase,
      runtimeUnavailable: [
        { id: 'pi', cause: 'not_installed', retryable: true },
        { id: 'pi', cause: 'not_executable', retryable: true },
      ],
    })).toThrow(/duplicate runtime-unavailable/);
    expect(() => ConnHelloPayloadSchema.parse({
      ...helloBase,
      runtimeUnavailable: Array.from({ length: 17 }, (_, index) => ({
        id: HarnessIdSchema.parse(`harness-${index}`), cause: 'not_installed', retryable: true,
      })),
    })).toThrow();
  });

  it('rejects a malformed projection while preserving the existing closed runtime shape', () => {
    expect(() => RuntimeVersionPolicyProjectionSchema.parse({ state: 'invented' })).toThrow();
    expect(() => RuntimeUnavailableEntrySchema.parse({ id: 'pi', cause: 'not_installed' })).toThrow(/retryable/);
  });
});

describe('PresencePublishRequest version policy projection (#1103 D8)', () => {
  it('round-trips the same runtimes[] projection and a built-in-runtime-only unavailable list', () => {
    const payload = PresencePublishRequestSchema.parse({
      level: 'online',
      runtimes: [
        { id: 'claude', version: '2.1.312', versionPolicy: { state: 'allow', qualifiedVersion: '2.1.312' } },
        { id: 'codex', version: '0.160.0', versionPolicy: { state: 'block', qualifiedVersion: '0.160.0' } },
      ],
      runtimeUnavailable: [
        { id: 'codex', cause: 'version_blocked', retryable: false },
        { id: 'pi', cause: 'not_installed', retryable: true },
      ],
    });
    expect(payload.runtimes?.map((runtime) => runtime.versionPolicy?.state)).toEqual(['allow', 'block']);
    expect(payload.runtimeUnavailable).toEqual([
      { id: 'codex', cause: 'version_blocked', retryable: false },
      { id: 'pi', cause: 'not_installed', retryable: true },
    ]);
  });

  it('rejects a harness id in the presence id domain, which stays RuntimeId', () => {
    expect(() => PresencePublishRequestSchema.parse({
      level: 'online',
      runtimeUnavailable: [{ id: 'grok', cause: 'not_installed', retryable: true }],
    })).toThrow();
  });

  it('strips an unknown field rather than rejecting the body (an old receiver drops it)', () => {
    const payload = PresencePublishRequestSchema.parse({ level: 'online', futureDiscovery: { state: 'allow' } });
    expect(payload).toEqual({ level: 'online' });
  });
});

describe('old-reader compatibility: closed objects drop the new fields', () => {
  it('a pre-#1103 RuntimeInfo object strips versionPolicy and keeps its own fields', () => {
    const oldRuntimeInfo = z.object({
      id: RuntimeIdSchema,
      version: z.string().optional(),
      authPresent: z.boolean().optional(),
      capabilities: RuntimeCapabilitiesSchema.optional(),
    });
    const parsed = oldRuntimeInfo.parse({
      id: 'codex', version: '0.160.0', authPresent: true,
      versionPolicy: { state: 'block', qualifiedVersion: '0.160.0' },
      futureField: 'dropped',
    });
    expect(parsed).toEqual({ id: 'codex', version: '0.160.0', authPresent: true });
    expect(parsed).not.toHaveProperty('versionPolicy');
  });
});
