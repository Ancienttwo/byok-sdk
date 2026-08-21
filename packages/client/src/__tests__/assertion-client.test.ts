import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeviceAssertion } from '@byok-sdk/core';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import * as publicApi from '../index';
import { requestDeviceAssertion } from '../daemon/assertion-client';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Plan `device-assertion-broker`, public-surface half.
 *
 * Two things are pinned here, and the SECOND one is the load-bearing one:
 * `requestDeviceAssertion` works end to end, and it is the ONLY control-socket
 * capability this package makes public. The control client can also shut the
 * daemon down, resolve approvals, and stream the raw task feed; exporting it
 * would make every one of those a supported API in a single line, and taking
 * that back later is a breaking change. A constraint test is the cheapest way
 * to make that a decision someone has to consciously reverse.
 */

const ALLOWED_AUDIENCE = 'salesko-api';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('client public surface', () => {
  it('does not export the control client, in any spelling', () => {
    const exported = Object.keys(publicApi);
    expect(exported).not.toContain('connectControlClient');
    expect(exported).not.toContain('ControlClient');
    expect(exported).not.toContain('ControlError');
    expect(exported).not.toContain('isControlDaemonGone');
    expect(exported).toContain('requestDeviceAssertion');
  });

  it('re-exports no module from bin/ except through requestDeviceAssertion', () => {
    // A type-only re-export leaves no runtime key behind, so the runtime check
    // above cannot see one. Scan the index source too.
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const withoutComments = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(withoutComments).not.toContain("from './bin/control-client'");
    expect(withoutComments).not.toContain('connectControlClient');
    expect(withoutComments).not.toMatch(/export .*\bControlClient\b/);
  });

  it('keeps the assertion broker out of every module-level key cache', () => {
    // "No module-level private key" made structural: the one file that
    // imports the key is small enough to scan, and it must hold no module
    // state at all.
    const signer = readFileSync(new URL('../daemon/device-assertion-signer.ts', import.meta.url), 'utf8');
    const code = signer.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // No top-level mutable binding whatsoever (a cache needs one).
    expect(code).not.toMatch(/^(let|var)\s/m);
    // The key is imported exactly once, inside the mint function.
    expect(code.match(/importPrivateKeyPem\(/g)).toHaveLength(1);
    // And no other daemon module reaches for the private key on this path.
    const createDaemon = readFileSync(new URL('../daemon/create-daemon.ts', import.meta.url), 'utf8');
    expect(createDaemon).not.toContain('importPrivateKeyPem');
    expect(createDaemon).not.toContain('devicePrivateKeyPem');
  });

  it('codex round-2 F3: the public surface exposes no assertion-signing injection and no key-bearing callback', () => {
    // The signer-observer seam (`AssertionIssueProbe` / `buildDaemonWithAdapters`)
    // must be reachable ONLY by importing the daemon module directly — never
    // through anything the package index re-exports, which is the public API a
    // production embedder consumes.
    const exported = Object.keys(publicApi);
    expect(exported).not.toContain('buildDaemonWithAdapters');
    expect(exported).not.toContain('AssertionIssueProbe');

    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const indexNoComments = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['buildDaemonWithAdapters', 'AssertionIssueProbe', 'onIssued', 'devicePrivateKeyPem']) {
      expect(indexNoComments, `index.ts must not surface ${forbidden}`).not.toContain(forbidden);
    }

    // The public `DaemonOverrides` interface must carry no assertion-signing
    // injection at all — no `mint`, no `deviceAssertion` seam, and nothing that
    // could ever receive the private key.
    const createDaemon = readFileSync(new URL('../daemon/create-daemon.ts', import.meta.url), 'utf8');
    const overridesBody = extractInterfaceBody(createDaemon, 'DaemonOverrides');
    expect(overridesBody).not.toMatch(/\bmint\b/);
    expect(overridesBody).not.toMatch(/\bdeviceAssertion\b/);
    expect(overridesBody).not.toContain('DeviceRecord');
    expect(overridesBody).not.toContain('devicePrivateKeyPem');

    // The `AssertionIssueProbe.onIssued` callback receives non-secret metadata
    // only — its signature must mention neither the record nor the key.
    const probeBody = extractInterfaceBody(createDaemon, 'AssertionIssueProbe');
    expect(probeBody).toContain('onIssued');
    expect(probeBody).toContain('jti');
    expect(probeBody).toContain('audience');
    expect(probeBody).not.toContain('record');
    expect(probeBody).not.toContain('DeviceRecord');
    expect(probeBody).not.toContain('devicePrivateKeyPem');
    expect(probeBody).not.toContain('envelope');
    expect(probeBody).not.toContain('signature');
  });

  it('the public surface exposes no store-mutex override at all', () => {
    // The owner lease is the fail-closed authority over store mutations: an
    // embedder must never be able to point it somewhere else, whether by
    // acquiring it directly or by overriding where the lock is held. (The
    // test-only port seam this originally guarded — `resolveStoreMutexPort` /
    // `AcquireDaemonOwnerOptions.mutexPort` — is gone with the TCP port
    // namespace itself; the lock endpoint is now derived from the storeDir and
    // has no override to expose. The invariant outlives the seam, so the names
    // stay listed here and any reintroduction turns this red.)
    const exported = Object.keys(publicApi);
    for (const forbidden of ['__setStoreMutexPortProviderForTests', 'AcquireDaemonOwnerOptions', 'acquireDaemonOwner']) {
      expect(exported).not.toContain(forbidden);
    }

    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const indexNoComments = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['__setStoreMutexPortProviderForTests', 'mutexPort', 'storeMutexPort', 'AcquireDaemonOwnerOptions']) {
      expect(indexNoComments, `index.ts must not surface ${forbidden}`).not.toContain(forbidden);
    }

    const createDaemon = readFileSync(new URL('../daemon/create-daemon.ts', import.meta.url), 'utf8');
    for (const iface of ['DaemonConfig', 'DaemonOverrides']) {
      const body = extractInterfaceBody(createDaemon, iface);
      expect(body, `${iface} must expose no store-mutex override`).not.toMatch(/mutexPort|storeMutexPort|mutexEndpoint/);
    }

    // The seam's whole machinery, not just its public reachability: nothing in
    // `create-daemon.ts` may hand `acquireDaemonOwner` a lock address again.
    expect(createDaemon, 'create-daemon.ts must not reintroduce a store-mutex port seam').not.toMatch(
      /__setStoreMutexPortProviderForTests|resolveStoreMutexPort|VITEST_MUTEX/,
    );
  });
});

/** Extracts the brace-balanced body of `export interface <name> { ... }` from source. */
function extractInterfaceBody(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const open = start + marker.length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in interface ${name}`);
}

describe('requestDeviceAssertion', () => {
  let server: TestServer;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    for (const started of daemons.splice(0)) await started.stop().catch(() => undefined);
    await server.close();
  });

  async function pairedAndStarted(productId: string, deviceAssertion?: DaemonConfig['deviceAssertion']): Promise<{
    storeDir: string;
    productId: string;
  }> {
    const workspaceRoot = await tmpDir(`byok-assert-client-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-assert-client-${productId}-store-`);
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      ...(deviceAssertion === undefined ? {} : { deviceAssertion }),
    };
    const built = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    daemons.push(built);
    await built.pair('pairing-code');
    await built.start();
    return { storeDir, productId };
  }

  it('returns a verifiable assertion from a running, configured daemon', async () => {
    const built = await pairedAndStarted('acme-req-ok', { audiences: [ALLOWED_AUDIENCE] });

    const result = await requestDeviceAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      audience: ALLOWED_AUDIENCE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assertion.protected.audience).toBe(ALLOWED_AUDIENCE);
    expect(result.expiresAt).toBe(result.assertion.protected.expiresAt);

    const record = JSON.parse(await fs.readFile(path.join(built.storeDir, 'device.json'), 'utf8')) as {
      devicePublicKey: string;
    };
    await expect(
      verifyDeviceAssertion(result.assertion, {
        verifier: {
          verify: ({ publicKey, signature, signingInput }) =>
            Promise.resolve(
              edVerify(
                null,
                signingInput,
                createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
                Buffer.from(signature, 'base64url'),
              ),
            ),
        },
        lookupDevice: () => ({ publicKeyJwkX: record.devicePublicKey, revoked: false }),
        now: new Date(result.assertion.protected.issuedAt),
      }),
    ).resolves.toBeDefined();
  });

  it('surfaces the daemon\'s own refusal code rather than throwing', async () => {
    const built = await pairedAndStarted('acme-req-denied', { audiences: [ALLOWED_AUDIENCE] });

    const denied = await requestDeviceAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      audience: 'salesko-api.evil.com',
    });
    expect(denied).toEqual({ ok: false, code: 'audience_denied', reason: expect.any(String) });

    const disabled = await pairedAndStarted('acme-req-off');
    const off = await requestDeviceAssertion({
      productId: disabled.productId,
      storeDir: disabled.storeDir,
      audience: ALLOWED_AUDIENCE,
    });
    expect(off.ok).toBe(false);
    if (off.ok) return;
    expect(off.code).toBe('assertion_disabled');
  });

  it('reports unavailable — never a pairing or revocation claim — when no daemon is running', async () => {
    const storeDir = await tmpDir('byok-assert-client-none-store-');
    const result = await requestDeviceAssertion({
      productId: 'acme-req-none',
      storeDir,
      audience: ALLOWED_AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.reason).toContain('daemon is not running');
  });
});
