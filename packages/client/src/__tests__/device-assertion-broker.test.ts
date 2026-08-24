import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import {
  DEVICE_ASSERTION_DOMAIN_PREFIX,
  DEVICE_ASSERTION_MAX_TTL_MS,
  DEVICE_ASSERTION_SCHEMA_ID,
  DEVICE_PROOF_DOMAIN_PREFIX,
  DeviceAssertionClaimsSchema,
  deviceAssertionSigningInput,
  parseDeviceAssertionEnvelope,
  verifyDeviceAssertion,
  type DeviceAssertionDeviceRow,
  type DeviceAssertionVerifier,
} from '@byok-sdk/core';
import { buildDaemonWithAdapters, createDaemonWithAdapters, type Daemon, type DaemonConfig, type DaemonOverrides } from '../daemon/create-daemon';
import { ControlError, type AssertionIssueResult } from '../daemon/control-protocol';
import { connectControlClient, type ControlClient } from '../bin/control-client';
import { createAuditAppender, auditLogPath } from '../bin/audit-log';
import { formatDaemonEventLine } from '../bin/format';
import { NONCE_SIGNING_DOMAIN } from '../daemon/device-keys';
import { DeviceStore } from '../daemon/store';
import type { DaemonEvent } from '../daemon/observer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Plan `device-assertion-broker`, client half: the `assertion.issue` control
 * method's six fail-closed gates, its audit projection, and its key hygiene,
 * driven end to end against a REAL `createDaemonWithAdapters` daemon over a
 * REAL control socket (the convention `daemon-control-socket.test.ts` already
 * uses) — never against a hand-built stub of the handler, because the thing
 * being asserted IS the wiring.
 *
 * Two things codex's adversarial pass demanded that shape this file:
 * - **Every gate-rejection asserts the signer was NEVER reached** (not merely
 *   that an error came back). A fail-closed gate's whole contract is that
 *   nothing is signed on refusal, so `pairedAndStarted` injects a counting
 *   signer and each refusal asserts `signer.count === 0` (codex F6b).
 * - **The nonce-inclusive domain-separation falsifier lives here**, importing
 *   the real production `NONCE_SIGNING_DOMAIN` from `device-keys.ts` (core
 *   cannot import it), so drift in that constant turns this test red (F6c).
 */

const ALLOWED_AUDIENCE = 'salesko-api';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** The real Ed25519 verification core deliberately does not contain. */
const nodeVerifier: DeviceAssertionVerifier = {
  verify: ({ algorithm, publicKey, signature, signingInput }) => {
    if (algorithm !== 'ed25519') return Promise.resolve(false);
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return Promise.resolve(edVerify(null, signingInput, key, Buffer.from(signature, 'base64url')));
  },
};

async function readDeviceRecord(storeDir: string): Promise<{ deviceId: string; devicePublicKey: string }> {
  const raw = await fs.readFile(path.join(storeDir, 'device.json'), 'utf8');
  return JSON.parse(raw) as { deviceId: string; devicePublicKey: string };
}

/** A lookup port that resolves the on-disk device row — the shape core's verifier now requires. */
function lookupFromStore(storeDir: string): (deviceId: string) => Promise<DeviceAssertionDeviceRow | undefined> {
  return async () => {
    const record = await readDeviceRecord(storeDir);
    return { publicKeyJwkX: record.devicePublicKey, revoked: false };
  };
}

describe('device assertion broker: assertion.issue', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  const openClients: ControlClient[] = [];
  // Every daemon this describe creates is tracked here and GUARANTEED stopped
  // in afterEach, even when a test body throws. A daemon's owner lease is a
  // cross-process port mutex derived from its storeDir hash (`daemon-owner.ts`);
  // a daemon left un-stopped keeps that port bound past the test and races a
  // later test (in another parallel worker) that hashes to the same port —
  // surfacing as `DaemonOwnerActiveError: ... held by an active unknown
  // process`. `stop()` is idempotent, so tracking + stopping ALL of them here
  // covers the RPC-shutdown/unpair tests too, which previously nulled `daemon`
  // and handed teardown to an un-awaited async shutdown.
  const createdDaemons: Daemon[] = [];

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of openClients.splice(0)) client.close();
    daemon = undefined;
    for (const created of createdDaemons.splice(0)) {
      await created.stop().catch(() => undefined);
    }
    await server.close();
  });

  interface Started {
    daemon: Daemon;
    config: DaemonConfig;
    storeDir: string;
    adapter: StubRuntimeAdapter;
    /**
     * codex round-2 F3/F6b: counts POST-SIGN observer invocations, via the
     * internal `AssertionIssueProbe` seam (`buildDaemonWithAdapters`, NOT any
     * public type). The observer only fires after a real successful sign with
     * `{jti, audience}` — never the private key — so a gate rejection leaves
     * this at 0, and the seam cannot forge or exfiltrate anything.
     */
    signer: { count: number };
  }

  async function pairedAndStarted(
    productId: string,
    config: Partial<DaemonConfig> = {},
    overrides: DaemonOverrides = {},
    adapter: StubRuntimeAdapter = new StubRuntimeAdapter('pi'),
  ): Promise<Started> {
    const workspaceRoot = await tmpDir(`byok-assert-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-assert-${productId}-store-`);
    const full: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      deviceAssertion: { audiences: [ALLOWED_AUDIENCE] },
      ...config,
    };
    const signer = { count: 0 };
    const built = buildDaemonWithAdapters(full, [adapter], overrides, {
      onIssued: () => {
        signer.count += 1;
      },
    });
    // Track BEFORE pair()/start() acquire the owner lease, so even a failure
    // during startup is still torn down (and its lease released) by afterEach.
    createdDaemons.push(built);
    await built.pair('pairing-code');
    await built.start();
    return { daemon: built, config: full, storeDir, adapter, signer };
  }

  async function control(storeDir: string, productId: string): Promise<ControlClient> {
    const conn = await connectControlClient({ storeDir, productId });
    if (!conn.ok) throw new Error(`expected a reachable control socket: ${conn.reason}`);
    openClients.push(conn.client);
    return conn.client;
  }

  async function expectControlError(promise: Promise<unknown>): Promise<ControlError> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(ControlError);
      return err as ControlError;
    }
    throw new Error('expected assertion.issue to be refused, but it resolved');
  }

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('mints an assertion that core\'s own verifier accepts against the paired device key', async () => {
    const built = await pairedAndStarted('acme-assert-ok');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const result = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    const envelope = parseDeviceAssertionEnvelope(result.assertion);
    const record = await readDeviceRecord(built.storeDir);

    const claims = await verifyDeviceAssertion(envelope, {
      verifier: nodeVerifier,
      lookupDevice: lookupFromStore(built.storeDir),
      now: new Date(envelope.protected.issuedAt),
    });

    expect(built.signer.count).toBe(1);
    expect(claims).toBeDefined();
    expect(claims?.audience).toBe(ALLOWED_AUDIENCE);
    // The deviceId comes from the on-disk record, never from anything the
    // caller said.
    expect(claims?.deviceId).toBe(record.deviceId);
    expect(claims?.productId).toBe('acme-assert-ok');
    expect(claims?.issuer).toBe(new URL(server.url).origin);
    expect(result.expiresAt).toBe(envelope.protected.expiresAt);
    // Default TTL, and no caller influence over it.
    expect(Date.parse(envelope.protected.expiresAt) - Date.parse(envelope.protected.issuedAt)).toBe(120_000);
  });

  it('honours a configured ttlMs and never lets a caller choose one', async () => {
    const built = await pairedAndStarted('acme-assert-ttl', {
      deviceAssertion: { audiences: [ALLOWED_AUDIENCE], ttlMs: 30_000 },
    });
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const result = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    const envelope = parseDeviceAssertionEnvelope(result.assertion);
    expect(Date.parse(envelope.protected.expiresAt) - Date.parse(envelope.protected.issuedAt)).toBe(30_000);

    // A caller asking for a longer one is a `bad_request` (unknown key), not a
    // longer assertion — and it mints nothing.
    const err = await expectControlError(
      client.request('assertion.issue', { audience: ALLOWED_AUDIENCE, ttlMs: DEVICE_ASSERTION_MAX_TTL_MS }),
    );
    expect(err.code).toBe('bad_request');
    expect(built.signer.count).toBe(1); // only the first, legitimate call ever signed
  });

  // -------------------------------------------------------------------------
  // Gate 3: audience allowlist, exact match only
  // -------------------------------------------------------------------------

  it('denies every near-miss audience, including the classic prefix attacks, and signs none of them', async () => {
    const built = await pairedAndStarted('acme-assert-audience');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const attacks = [
      // A `startsWith` allowlist would admit this one — it is the whole reason
      // the check is `Set.has`.
      'salesko-api.evil.com',
      'salesko-api.evil',
      'salesko-apiX',
      // A `endsWith` rule would admit this one.
      'evil.com/salesko-api',
      'evil-salesko-api',
      // A truncation of an allowed entry.
      'salesko-ap',
      'salesko',
      // Case and whitespace are not normalized either.
      'SALESKO-API',
      ' salesko-api',
      'salesko-api ',
    ];

    for (const audience of attacks) {
      const err = await expectControlError(client.request('assertion.issue', { audience }));
      expect(err.code, `audience ${JSON.stringify(audience)} must be denied`).toBe('audience_denied');
      // A refusal must not be an enumeration oracle: the message may not echo
      // the allowlist back at the caller.
      expect(err.message).not.toContain(ALLOWED_AUDIENCE);
    }
    // codex F6b: not one of those refusals reached the signer.
    expect(built.signer.count).toBe(0);
  });

  it('matches a multi-entry allowlist exactly, entry by entry', async () => {
    const built = await pairedAndStarted('acme-assert-multi', {
      deviceAssertion: { audiences: ['a-api', 'b-api'] },
    });
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    for (const audience of ['a-api', 'b-api']) {
      const result = await client.request<AssertionIssueResult>('assertion.issue', { audience });
      expect(parseDeviceAssertionEnvelope(result.assertion).protected.audience).toBe(audience);
    }
    expect((await expectControlError(client.request('assertion.issue', { audience: 'c-api' }))).code).toBe(
      'audience_denied',
    );
    expect(built.signer.count).toBe(2); // two allowed, the denied one never signed
  });

  // -------------------------------------------------------------------------
  // Gate ordering + gates 1/2
  // -------------------------------------------------------------------------

  it('answers assertion_disabled before it even looks at the params, and signs nothing', async () => {
    const built = await pairedAndStarted('acme-assert-off', { deviceAssertion: undefined });
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    // Malformed params AND a would-be-denied audience: gate 1 fires first for
    // every one of them, so a daemon with the feature off is indistinguishable
    // from one with an empty allowlist no matter what is sent.
    for (const params of [undefined, {}, { audience: 123 }, { audience: ALLOWED_AUDIENCE }, { audience: 'other' }]) {
      const err = await expectControlError(client.request('assertion.issue', params));
      expect(err.code).toBe('assertion_disabled');
    }
    expect(built.signer.count).toBe(0);
  });

  it('treats an empty audience list as off, not as an allowlist that denies everything', async () => {
    const built = await pairedAndStarted('acme-assert-empty', { deviceAssertion: { audiences: [] } });
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);
    const err = await expectControlError(client.request('assertion.issue', { audience: ALLOWED_AUDIENCE }));
    expect(err.code).toBe('assertion_disabled');
    expect(built.signer.count).toBe(0);
  });

  it('answers bad_request before audience_denied, so a malformed request cannot probe the allowlist', async () => {
    const built = await pairedAndStarted('acme-assert-params');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const negatives: readonly (readonly [string, unknown])[] = [
      ['non-object params', 'salesko-api'],
      ['missing audience', {}],
      ['non-string audience', { audience: 123 }],
      ['empty audience', { audience: '' }],
      // An unknown key is rejected even when the audience itself IS allowed —
      // a tolerated extra field is how a caller comes to believe it can
      // influence the claim set.
      ['unknown extra key alongside an allowed audience', { audience: ALLOWED_AUDIENCE, ttlMs: 1000 }],
      ['array audience', { audience: [ALLOWED_AUDIENCE] }],
      ['oversized audience', { audience: 'a'.repeat(257) }],
      ['oversized multi-byte audience', { audience: '受'.repeat(86) }],
    ];

    for (const [name, params] of negatives) {
      const err = await expectControlError(client.request('assertion.issue', params));
      expect(err.code, name).toBe('bad_request');
    }
    expect(built.signer.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Gates 4/5/6 — the three "this device may not sign right now" branches
  // -------------------------------------------------------------------------

  it('refuses with not_paired once the OS enrollment authority is gone, without a restart', async () => {
    const built = await pairedAndStarted('acme-assert-unpaired');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    // Proves the OS authority is genuinely re-read per call rather than cached
    // at start. device.json alone is only a repairable non-secret projection.
    await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    await new DeviceStore(built.storeDir, undefined, built.config.productId).credentials.clear();

    const err = await expectControlError(client.request('assertion.issue', { audience: ALLOWED_AUDIENCE }));
    expect(err.code).toBe('not_paired');
    expect(built.signer.count).toBe(1); // the pre-removal call signed; the post-removal one did not
  });

  it('refuses with revoked once the server has revoked this device', async () => {
    const built = await pairedAndStarted('acme-assert-revoked', {}, { backoff: { baseMs: 20, maxMs: 100, factor: 2 } });
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);
    const record = await readDeviceRecord(built.storeDir);

    await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });

    // Revoking server-side is not something the daemon learns spontaneously —
    // it finds out on its next authenticated round trip, exactly as in
    // production. Dropping the connection is what forces that round trip now.
    server.revokeDevice(record.deviceId);
    server.dropConnection();
    await vi.waitFor(() => expect(daemon?.status().revoked).toBe(true), { timeout: 10_000 });

    const err = await expectControlError(client.request('assertion.issue', { audience: ALLOWED_AUDIENCE }));
    expect(err.code).toBe('revoked');
    expect(built.signer.count).toBe(1); // only the pre-revocation call signed
    // The device record is still on disk — this refusal is the revocation
    // gate, not the not_paired one behind it.
    await expect(fs.stat(path.join(built.storeDir, 'device.json'))).resolves.toBeDefined();
  }, 20_000);

  it('refuses with shutting_down in the window between the shutdown ack and the socket closing', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    // Large grace so the held-open teardown ALWAYS waits for release() rather
    // than hitting a deadline under parallel-suite load — a deadline hit would
    // leave `mutationBarrierComplete` false and RETAIN the owner-lease port,
    // which is exactly the cross-file test-isolation leak this must avoid.
    const built = await pairedAndStarted('acme-assert-shutdown', { shutdownGraceMs: 60_000 }, {}, adapter);
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    // An active task whose teardown is held open is what KEEPS that window
    // open long enough to observe deterministically. In production the same
    // window exists on every unpair — the CLI shuts the daemon down first and
    // clears device.json afterwards — it is just narrower.
    server.send(
      createEnvelope('task.offer', { instruction: 'work', policy: { mode: 'auto' } }, { taskId: 't-shutdown', seq: server.nextSeq() }),
    );
    await server.waitFor((event) => event.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const release = adapter.sessions[0]!.blockClose();
    try {
      const shutdownRequested = new Promise<void>((resolve) => {
        const unsubscribe = daemon!.subscribe((event: DaemonEvent) => {
          if (event.kind === 'shutdown-requested') {
            unsubscribe();
            resolve();
          }
        });
      });

      await client.request('shutdown', { reason: 'unpair' });
      // `shuttingDown` is latched synchronously immediately before this event
      // is emitted, so observing the event means the gate is armed.
      await shutdownRequested;

      const err = await expectControlError(client.request('assertion.issue', { audience: ALLOWED_AUDIENCE }));
      expect(err.code).toBe('shutting_down');
      expect(built.signer.count).toBe(0);

      // Deterministically finish teardown IN THE TEST: unblock the session,
      // then await the shutdown to completion so the owner-lease port is
      // released here (and any teardown error surfaces) rather than being
      // deferred to afterEach where it would be swallowed.
      release();
      await built.daemon.stop();
    } finally {
      release();
    }
  }, 30_000);

  it('codex F1: a pipelined shutdown+assertion.issue batch mints nothing — the latch is armed synchronously', async () => {
    const built = await pairedAndStarted('acme-assert-pipeline');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    // No active task and no blockClose: the two RPCs are written back-to-back
    // in the same tick, so the server reads both lines and dispatches them
    // (shutdown then assertion.issue) as microtasks BEFORE the shutdown's own
    // `setImmediate` teardown macrotask runs. If the latch were only set inside
    // the deferred `performControlShutdown`, the assertion.issue on this tick
    // would still see `shuttingDown === false` and mint. F1 arms it as the
    // first statement of the shutdown handler, so it is already true when
    // assertion.issue runs. Keeping this leak-free (no held-open teardown) is
    // deliberate: the daemon tears down cleanly and releases its lease fast.
    const shutdownP = client.request('shutdown', { reason: 'unpair' });
    const assertionP = client.request('assertion.issue', { audience: ALLOWED_AUDIENCE });

    await shutdownP;
    const err = await expectControlError(assertionP);
    expect(err.code).toBe('shutting_down');
    expect(built.signer.count).toBe(0);

    // Await full teardown here so the lease releases deterministically.
    await built.daemon.stop();
  }, 30_000);

  it('codex round-2 F1: a stop() queued behind an in-progress pair() still blocks minting', async () => {
    const built = await pairedAndStarted('acme-assert-queued-stop');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    // Occupy the client's lifecycle-mutation queue with a pair() the server
    // holds open. runShutdownSequence (which also sets the latch) is queued
    // BEHIND this and has NOT run — so only the synchronous arming at the top
    // of stop() itself can block the concurrent assertion.issue.
    const releasePair = server.blockNextPair();
    const pairP = built.daemon.pair('pairing-code-2');
    try {
      // Give the pair() request time to reach the (blocked) server handler and
      // take the lifecycle slot before stop() is enqueued behind it.
      await vi.waitFor(() => expect(server.httpRequests.some((r) => r.pathname === '/byok/pair' && r.method === 'POST')).toBe(true));

      const stopP = built.daemon.stop();
      const err = await expectControlError(client.request('assertion.issue', { audience: ALLOWED_AUDIENCE }));
      expect(err.code).toBe('shutting_down');
      expect(built.signer.count).toBe(0);

      // Release the pair so the queued stop() can drain, then let both settle.
      releasePair();
      await Promise.allSettled([pairP, stopP]);
    } finally {
      // On any throw above, still unblock pair() so afterEach's stop() (queued
      // behind it) can complete and release the owner-lease port.
      releasePair();
      await pairP.catch(() => undefined);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // jti: unpredictable, never reused, including under concurrency
  // -------------------------------------------------------------------------

  it('mints a distinct jti on every call', async () => {
    const built = await pairedAndStarted('acme-assert-jti');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const jtis = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const result = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
      const { jti } = parseDeviceAssertionEnvelope(result.assertion).protected;
      expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
      jtis.add(jti);
    }
    expect(jtis.size).toBe(25);
    expect(built.signer.count).toBe(25);
  });

  it('keeps jtis distinct and both signatures valid for two concurrent issues', async () => {
    const built = await pairedAndStarted('acme-assert-concurrent');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const [first, second] = await Promise.all([
      client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE }),
      client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE }),
    ]);

    const envelopes = [parseDeviceAssertionEnvelope(first.assertion), parseDeviceAssertionEnvelope(second.assertion)];
    expect(envelopes[0]!.protected.jti).not.toBe(envelopes[1]!.protected.jti);
    for (const envelope of envelopes) {
      await expect(
        verifyDeviceAssertion(envelope, {
          verifier: nodeVerifier,
          lookupDevice: lookupFromStore(built.storeDir),
          now: new Date(envelope.protected.issuedAt),
        }),
      ).resolves.toBeDefined();
    }
    expect(built.signer.count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('writes assertion metadata to the audit log and never the signature or the envelope', async () => {
    const built = await pairedAndStarted('acme-assert-audit');
    daemon = built.daemon;
    daemon.subscribe(createAuditAppender(built.storeDir));
    const client = await control(built.storeDir, built.config.productId);

    const issued = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    const envelope = parseDeviceAssertionEnvelope(issued.assertion);
    const deniedAudience = 'super-secret-internal-audience-name';
    await expectControlError(client.request('assertion.issue', { audience: deniedAudience }));

    const logPath = auditLogPath(built.storeDir);
    await vi.waitFor(async () => {
      const raw = await fs.readFile(logPath, 'utf8');
      expect(raw).toContain('"result":"denied"');
      expect(raw).toContain('"result":"issued"');
    });
    const raw = await fs.readFile(logPath, 'utf8');

    // What must NEVER be there.
    expect(raw).not.toContain(envelope.signature);
    expect(raw).not.toContain('"signature"');
    expect(raw).not.toContain('-----BEGIN');
    expect(raw).not.toContain('"assertion"');
    expect(raw).not.toContain('"protected"');
    // A denied audience is caller free text — only its size is persisted.
    expect(raw).not.toContain(deniedAudience);
    expect(raw).toContain(`"audienceSize":${Buffer.byteLength(deniedAudience, 'utf8')}`);
    expect(raw).toContain('"reason":"audience_denied"');

    // What must be there, so an incident can trace an assertion back to the
    // call that minted it.
    expect(raw).toContain(`"audience":"${ALLOWED_AUDIENCE}"`);
    expect(raw).toContain(`"jti":"${envelope.protected.jti}"`);
    expect(raw).toContain(`"expiresAt":"${envelope.protected.expiresAt}"`);
  });

  it('codex round-2 F4: a denied audience never reaches the live observer event or the stdout line — only its size', async () => {
    const built = await pairedAndStarted('acme-assert-denied-leak');
    daemon = built.daemon;

    // A secret-shaped, non-allowlisted audience under the 256-byte bound so it
    // reaches the audience_denied gate (not bad_request for oversize). This is
    // the exfil vector F4 closes: a caller submitting a secret AS an audience.
    const secretAudience = 'sig:MEUCIQDsecret-signature-bytes-that-must-never-be-logged-AAAA';
    expect(Buffer.byteLength(secretAudience, 'utf8')).toBeLessThanOrEqual(256);

    const events: DaemonEvent[] = [];
    const unsubscribe = daemon.subscribe((event) => events.push(event));
    const client = await control(built.storeDir, built.config.productId);

    const err = await expectControlError(client.request('assertion.issue', { audience: secretAudience }));
    expect(err.code).toBe('audience_denied');
    unsubscribe();

    const denied = events.find((e) => e.kind === 'device-assertion' && e.result === 'denied');
    expect(denied).toBeDefined();
    // The live in-memory DaemonEvent itself must carry only a size, never the
    // raw string — structural, not a redact-after-the-fact rule.
    const serializedEvent = JSON.stringify(denied);
    expect(serializedEvent).not.toContain(secretAudience);
    expect(serializedEvent).not.toContain('sig:MEUCIQ');
    expect(serializedEvent).toContain(`"audienceSize":${Buffer.byteLength(secretAudience, 'utf8')}`);

    // And the human-facing stdout line the daemon prints live to
    // foreground/systemd/launchd/WinSW must never contain the raw string.
    const line = formatDaemonEventLine(denied!);
    expect(line).not.toContain(secretAudience);
    expect(line).not.toContain('sig:MEUCIQ');
    expect(line).toContain(`audienceSize=${Buffer.byteLength(secretAudience, 'utf8')}`);
    expect(line).toContain('result=denied');
  });

  // -------------------------------------------------------------------------
  // Key hygiene
  // -------------------------------------------------------------------------

  it('never returns key material to the caller', async () => {
    const built = await pairedAndStarted('acme-assert-hygiene');
    daemon = built.daemon;
    const client = await control(built.storeDir, built.config.productId);

    const result = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('-----BEGIN');
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('devicePrivateKeyPem');
    // Not even the PUBLIC key: a verifier must resolve the key from its own
    // device directory by deviceId, or the envelope becomes self-authenticating.
    const record = await readDeviceRecord(built.storeDir);
    expect(serialized).not.toContain(record.devicePublicKey);
  });

});

// ---------------------------------------------------------------------------
// codex F6c: the authoritative three-way domain-separation falsifier — the
// only place that imports the REAL production `NONCE_SIGNING_DOMAIN` alongside
// core's two exported prefixes, so drift in ANY of the three turns this red.
// ---------------------------------------------------------------------------

describe('domain separation across all three signing domains (falsifier)', () => {
  const DOMAINS: readonly (readonly [string, string])[] = [
    ['nonce', NONCE_SIGNING_DOMAIN],
    ['device proof', DEVICE_PROOF_DOMAIN_PREFIX],
    ['device assertion', DEVICE_ASSERTION_DOMAIN_PREFIX],
  ];

  it('keeps the three production prefixes pairwise distinct and pairwise non-prefix', () => {
    for (const [leftName, left] of DOMAINS) {
      for (const [rightName, right] of DOMAINS) {
        if (leftName === rightName) continue;
        expect(left).not.toBe(right);
        expect(left.startsWith(right), `${leftName} must not start with ${rightName}`).toBe(false);
        expect(right.startsWith(left), `${rightName} must not start with ${leftName}`).toBe(false);
      }
    }
  });

  it('ends every production prefix with a newline, the structural non-prefix guarantee', () => {
    for (const [, domain] of DOMAINS) {
      expect(domain.endsWith('\n')).toBe(true);
      expect(domain.slice(0, -1)).not.toContain('\n');
    }
  });

  it('a nonce-domain Ed25519 signature does not verify as a device assertion', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyJwkX = (publicKey.export({ format: 'jwk' }) as { x: string }).x;

    const claims = DeviceAssertionClaimsSchema.parse({
      version: 1,
      issuer: 'https://api.example.com',
      productId: 'product-a',
      deviceId: 'device-1',
      audience: 'salesko-api',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
    });

    // A signature over the REAL nonce domain, wrapped in an assertion envelope.
    const nonceSignature = edSign(
      null,
      Buffer.from(NONCE_SIGNING_DOMAIN + 'some-challenge-nonce', 'utf8'),
      privateKey,
    ).toString('base64url');

    await expect(
      verifyDeviceAssertion(
        { schema: DEVICE_ASSERTION_SCHEMA_ID, algorithm: 'ed25519', protected: claims, signature: nonceSignature },
        {
          verifier: nodeVerifier,
          lookupDevice: () => ({ publicKeyJwkX, revoked: false }),
          now: new Date(claims.issuedAt),
        },
      ),
    ).resolves.toBeUndefined();

    // And the reverse: a genuine assertion signature does not verify over the
    // nonce domain's own bytes.
    const assertionSignature = Buffer.from(edSign(null, deviceAssertionSigningInput(claims), privateKey));
    expect(
      edVerify(null, Buffer.from(NONCE_SIGNING_DOMAIN + 'some-challenge-nonce', 'utf8'), publicKey, assertionSignature),
    ).toBe(false);
  });
});

describe('device assertion broker: config validation is a construction error', () => {
  // These daemons are only CONSTRUCTED (to assert on config validation) and
  // never started/paired, so none acquires an owner lease. Even so, each gets
  // a unique store path — no two of these constructions share one — so there is
  // categorically no shared-store surface. A synchronous unique path is fine
  // here precisely because nothing ever writes to it.
  let configSeq = 0;
  function build(deviceAssertion: unknown): () => Daemon {
    const unique = `${process.pid}-${configSeq++}`;
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
      productId: `acme-assert-config-${unique}`,
      serverUrl: 'https://api.example.com',
      workspaceRoot: path.join(os.tmpdir(), `byok-assert-config-ws-${unique}`),
      storeDir: path.join(os.tmpdir(), `byok-assert-config-store-${unique}`),
      deviceAssertion,
    } as DaemonConfig;
    return () => createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
  }

  const negatives: readonly (readonly [string, unknown])[] = [
    ['a non-array audience list', { audiences: 'salesko-api' }],
    ['an empty-string audience entry', { audiences: ['salesko-api', ''] }],
    ['a non-string audience entry', { audiences: ['salesko-api', 42] }],
    ['a duplicate audience entry', { audiences: ['salesko-api', 'salesko-api'] }],
    ['an oversized audience entry', { audiences: ['a'.repeat(257)] }],
    ['a ttlMs above the hard ceiling', { audiences: ['salesko-api'], ttlMs: DEVICE_ASSERTION_MAX_TTL_MS + 1 }],
    ['a zero ttlMs', { audiences: ['salesko-api'], ttlMs: 0 }],
    ['a negative ttlMs', { audiences: ['salesko-api'], ttlMs: -1 }],
    ['a fractional ttlMs', { audiences: ['salesko-api'], ttlMs: 1000.5 }],
  ];

  for (const [name, deviceAssertion] of negatives) {
    it(`refuses to construct a daemon with ${name}`, () => {
      expect(build(deviceAssertion)).toThrow(/deviceAssertion/);
    });
  }

  it('constructs cleanly with a valid section, an empty list, or no section at all', () => {
    expect(build({ audiences: ['salesko-api'], ttlMs: DEVICE_ASSERTION_MAX_TTL_MS })).not.toThrow();
    expect(build({ audiences: [] })).not.toThrow();
    expect(build(undefined)).not.toThrow();
  });
});
