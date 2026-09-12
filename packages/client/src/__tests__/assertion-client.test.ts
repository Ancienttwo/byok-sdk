import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeviceAssertion, verifyTaskAssertion } from '@byok-sdk/core';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import * as publicApi from '../index';
import { createEnvelope } from '@byok-sdk/protocol';
import { requestDeviceAssertion, requestTaskAssertion } from '../daemon/assertion-client';
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
    // Contract §8.1: the task lane is a second public entry point, and still
    // the ONLY other one — it reaches exactly one control method.
    expect(exported).toContain('requestTaskAssertion');
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
    expect(exported).toContain('localStateRelocation');
    for (const forbidden of [
      '__setStoreMutexPortProviderForTests',
      'AcquireDaemonOwnerOptions',
      'acquireDaemonOwner',
      'acquirePathMutationGate',
      'acquirePathMutationGates',
      'PathMutationGate',
    ]) {
      expect(exported).not.toContain(forbidden);
    }

    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const indexNoComments = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [
      '__setStoreMutexPortProviderForTests',
      'mutexPort',
      'storeMutexPort',
      'AcquireDaemonOwnerOptions',
      'acquirePathMutationGate',
      'PathMutationGateBusyError',
    ]) {
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

/**
 * Contract §8.1 / §8.2(1), public-surface half of the task lane.
 *
 * `requestTaskAssertion` is the ONE function a host's MCP child calls, and the
 * properties pinned here are the ones that stop it from quietly becoming a
 * credential cache: it never reads the nonce out of the environment itself, it
 * mints nothing on its own, and every call is a fresh round trip.
 */
describe('requestTaskAssertion', () => {
  let server: TestServer;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    for (const started of daemons.splice(0)) await started.stop().catch(() => undefined);
    await server.close();
  });

  const TOOLSET = 'salesko.read.v1';
  const SERVER_NAME = 'saleskoread';

  async function startedWithTask(productId: string): Promise<{
    storeDir: string;
    productId: string;
    contextToken: string;
    adapter: StubRuntimeAdapter;
  }> {
    const workspaceRoot = await tmpDir(`byok-task-client-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-task-client-${productId}-store-`);
    const hostStorageRoot = await tmpDir(`byok-task-client-${productId}-home-`);
    const adapter = new StubRuntimeAdapter(
      'pi',
      { kind: 'available' },
      { steer: false, resume: true, approvalInteractive: true, mcpToolsets: true, permissionModes: ['auto'] },
      false,
    );
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      deviceAssertion: { audiences: [ALLOWED_AUDIENCE] },
      mcpToolsets: { [TOOLSET]: { mcpServers: { [SERVER_NAME]: { command: '/opt/salesko/read' } } } },
    };
    const built = createDaemonWithAdapters(config, [adapter]);
    daemons.push(built);
    await built.pair('pairing-code');
    await built.start();

    server.send(
      createEnvelope(
        'task.offer_for_agent',
        {
          instruction: 'qualify the inbound lead',
          policy: { mode: 'auto' },
          runtime: 'pi',
          agentRef: { agentId: 'salesko-agent', profileRevision: 'profile-rev-1' },
          requiredToolsets: [TOOLSET],
        },
        { taskId: `${productId}-task`, seq: server.nextSeq() },
      ),
    );
    await server.waitFor((envelope) => envelope.type === 'task.started');
    const contextToken = adapter.startCalls[0]?.ctx.mcpServers?.[SERVER_NAME]?.env?.BYOK_HOST_TOOLSET_CONTEXT;
    if (contextToken === undefined) throw new Error('expected the daemon to inject a host toolset context');
    return { storeDir, productId, contextToken, adapter };
  }

  it('returns a verifiable task assertion whose claims came from the daemon, not the caller', async () => {
    const built = await startedWithTask('acme-task-req-ok');

    const result = await requestTaskAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      contextToken: built.contextToken,
      audience: ALLOWED_AUDIENCE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assertion.schema).toBe('byok-task-assertion-v1');
    expect(result.assertion.protected.taskId).toBe('acme-task-req-ok-task');
    expect(result.assertion.protected.toolsetId).toBe(TOOLSET);
    expect(result.assertion.protected.agentRef).toEqual({ agentId: 'salesko-agent', profileRevision: 'profile-rev-1' });
    expect(result.expiresAt).toBe(result.assertion.protected.expiresAt);

    const record = JSON.parse(await fs.readFile(path.join(built.storeDir, 'device.json'), 'utf8')) as {
      devicePublicKey: string;
    };
    await expect(
      verifyTaskAssertion(result.assertion, {
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

  it('caches nothing: two calls are two round trips and two jti', async () => {
    const built = await startedWithTask('acme-task-req-fresh');
    const options = {
      productId: built.productId,
      storeDir: built.storeDir,
      contextToken: built.contextToken,
      audience: ALLOWED_AUDIENCE,
    };

    const first = await requestTaskAssertion(options);
    const second = await requestTaskAssertion(options);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.assertion.protected.jti).not.toBe(second.assertion.protected.jti);
    expect(first.assertion.signature).not.toBe(second.assertion.signature);
  });

  it('surfaces the two task-lane refusals verbatim rather than throwing', async () => {
    const built = await startedWithTask('acme-task-req-denied');

    const unknown = await requestTaskAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      contextToken: 'a'.repeat(43),
      audience: ALLOWED_AUDIENCE,
    });
    expect(unknown).toEqual({ ok: false, code: 'context_token_invalid', reason: expect.any(String) });

    const denied = await requestTaskAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      contextToken: built.contextToken,
      audience: 'salesko-api.evil.com',
    });
    expect(denied).toEqual({ ok: false, code: 'audience_denied', reason: expect.any(String) });

    // A cancelled task's nonce is refused with the precise second-layer code.
    const release = built.adapter.sessions[0]!.blockClose();
    server.send(
      createEnvelope('task.cancel', { reason: 'operator' }, { taskId: 'acme-task-req-denied-task', seq: server.nextSeq() }),
    );
    await server.waitFor((envelope) => envelope.type === 'task.cancelled');
    const revoked = await requestTaskAssertion({
      productId: built.productId,
      storeDir: built.storeDir,
      contextToken: built.contextToken,
      audience: ALLOWED_AUDIENCE,
    });
    expect(revoked).toEqual({ ok: false, code: 'context_revoked', reason: expect.any(String) });
    release();
  });

  it('reports unavailable — never a context or pairing claim — when no daemon is running', async () => {
    const storeDir = await tmpDir('byok-task-client-none-store-');
    const result = await requestTaskAssertion({
      productId: 'acme-task-req-none',
      storeDir,
      contextToken: 'b'.repeat(43),
      audience: ALLOWED_AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable');
    expect(result.reason).toContain('daemon is not running');
  });

  it('never reads the context token out of its own environment', async () => {
    // A helper that fell back to `process.env` would work just as well inside a
    // process the daemon never spawned for this task, which is exactly the
    // substitution the nonce exists to prevent. Structural, so it stays true.
    const source = readFileSync(new URL('../daemon/assertion-client.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('process.env');
    expect(code).not.toContain('BYOK_HOST_TOOLSET_CONTEXT');
  });
});
