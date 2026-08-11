import { CapabilityDeclarationSchema } from '@byok-sdk/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CapabilityDiscoveryError,
  declares,
  fetchCapabilityDeclaration,
  PRESENCE_HINTS_CAPABILITY,
} from '../daemon/capabilities-client';
import { startRealCloud, type RealCloudHandle } from './fixtures/real-cloud';

/**
 * The slice's falsifier, run FIRST: the whole design rests on ADR-010's
 * declaration-not-probe posture, so before any daemon code exists the real
 * `@byok-sdk/cloud` composition must actually serve a declaration that core's
 * schema accepts and that can carry `presence.hints`. If it could not, the
 * publisher would have nothing to gate on but a status code, which ADR-010
 * forbids outright.
 */
describe('GET /byok/capabilities against the real @byok-sdk/cloud composition', () => {
  let cloud: RealCloudHandle | undefined;

  afterEach(async () => {
    await cloud?.close();
    cloud = undefined;
  });

  it('serves a declaration that validates under core and carries presence.hints', async () => {
    cloud = await startRealCloud({ productId: 'test-product' });
    const response = await fetch(new URL('/byok/capabilities', cloud.url));
    expect(response.status).toBe(200);

    const declaration = CapabilityDeclarationSchema.parse(await response.json());
    expect(declaration.schema).toBe('byok-capabilities-v1');
    expect(declaration.capabilities).toContain(PRESENCE_HINTS_CAPABILITY);
  });

  it('reads that same declaration through the client, and gates on it', async () => {
    cloud = await startRealCloud({ productId: 'test-product' });
    const declaration = await fetchCapabilityDeclaration(cloud.url);
    expect(declares(declaration, PRESENCE_HINTS_CAPABILITY)).toBe(true);
    expect(declares(declaration, 'nothing.declared')).toBe(false);
  });

  it('reports a deployment that declares no presence hints as exactly that — no route probing involved', async () => {
    cloud = await startRealCloud({ productId: 'test-product', omitCapabilities: [PRESENCE_HINTS_CAPABILITY] });
    const declaration = await fetchCapabilityDeclaration(cloud.url);
    expect(declares(declaration, PRESENCE_HINTS_CAPABILITY)).toBe(false);
  });
});

describe('fetchCapabilityDeclaration fails closed', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respondWith(response: Response | (() => Promise<never>)): void {
    globalThis.fetch = (async () =>
      typeof response === 'function' ? response() : response) as typeof globalThis.fetch;
  }

  it('on a transport failure', async () => {
    respondWith(() => Promise.reject(new Error('connect ECONNREFUSED')));
    await expect(fetchCapabilityDeclaration('https://example.test')).rejects.toThrow(CapabilityDiscoveryError);
  });

  it('on a non-200 — including the 404 a probe-based client would have read as "unsupported"', async () => {
    respondWith(new Response('', { status: 404 }));
    await expect(fetchCapabilityDeclaration('https://example.test')).rejects.toThrow(/HTTP 404/);
  });

  it('on a body that is not JSON', async () => {
    respondWith(new Response('<html>proxy error</html>', { status: 200 }));
    await expect(fetchCapabilityDeclaration('https://example.test')).rejects.toThrow(/not JSON/);
  });

  it('on a body core’s schema rejects', async () => {
    respondWith(
      new Response(JSON.stringify({ schema: 'byok-capabilities-v1', version: 1, capabilities: ['Not A Name'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(fetchCapabilityDeclaration('https://example.test')).rejects.toThrow(/not a valid ADR-010 declaration/);
  });
});
