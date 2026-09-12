import { createPublicKey, verify as edVerify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, HOST_MCP_TASK_CONTEXT_CAPABILITY } from '@byok-sdk/protocol';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  TASK_ASSERTION_SCHEMA_ID,
  parseTaskAssertionEnvelope,
  verifyTaskAssertion,
  type DeviceAssertionDeviceRow,
  type DeviceAssertionVerifier,
} from '@byok-sdk/core';
import { buildDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import {
  ASSERTION_AUDIENCE_MAX_BYTES,
  ControlError,
  TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES,
  TASK_ASSERTION_ISSUE_ERROR_CODES,
  type AssertionIssueResult,
  type TaskAssertionIssueResult,
} from '../daemon/control-protocol';
import { connectControlClient, type ControlClient } from '../bin/control-client';
import { createAuditAppender, auditLogPath } from '../bin/audit-log';
import { formatDaemonEventLine } from '../bin/format';
import type { DaemonEvent } from '../daemon/observer';
import type { RuntimeCapabilities } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Contract §8.1 / §8.2(1) / I12 / AC11, daemon half: the `task_assertion.issue`
 * control method's EIGHT fail-closed gates, the `BYOK_HOST_TOOLSET_CONTEXT`
 * nonce registry those last two gates consult, and the two-layer revocation
 * that makes a cancelled task stop being able to mint tool authority.
 *
 * Driven end to end against a REAL daemon over a REAL control socket, for the
 * same reason `device-assertion-broker.test.ts` is: the thing under test IS the
 * wiring between the task runner's registry and the signer.
 *
 * The property every case here exists to hold: `taskId`/`agentRef`/`toolsetId`
 * come from the daemon's own registry entry for the injected nonce, never from
 * anything a caller sent — a caller that cannot produce the nonce cannot obtain
 * authority for the task, and a caller that can still cannot choose what the
 * assertion says about it.
 */

const ALLOWED_AUDIENCE = 'salesko-api';
const AGENT_ID = 'salesko-agent';
const PROFILE_REVISION = 'profile-rev-1';
const READ_TOOLSET = 'salesko.read.v1';
const PROPOSE_TOOLSET = 'salesko.propose.v1';
const READ_SERVER = 'saleskoread';
const PROPOSE_SERVER = 'saleskopropose';

const MCP_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

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

function lookupFromStore(storeDir: string): (deviceId: string) => Promise<DeviceAssertionDeviceRow | undefined> {
  return async () => {
    const record = await readDeviceRecord(storeDir);
    return { publicKeyJwkX: record.devicePublicKey, revoked: false };
  };
}

describe('task assertion broker: task_assertion.issue', () => {
  let server: TestServer;
  const openClients: ControlClient[] = [];
  const createdDaemons: Daemon[] = [];

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of openClients.splice(0)) client.close();
    for (const created of createdDaemons.splice(0)) await created.stop().catch(() => undefined);
    await server.close();
  });

  interface Started {
    daemon: Daemon;
    config: DaemonConfig;
    storeDir: string;
    adapter: StubRuntimeAdapter;
    signer: { count: number };
  }

  async function pairedAndStarted(productId: string, config: Partial<DaemonConfig> = {}): Promise<Started> {
    const workspaceRoot = await tmpDir(`byok-task-assert-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-task-assert-${productId}-store-`);
    const hostStorageRoot = await tmpDir(`byok-task-assert-${productId}-home-`);
    // `requiresMcpToolsetToolObservation = false`: these fixture commands never
    // exist on disk, so a real `tools/list` probe would decline the offer for a
    // reason that has nothing to do with what is under test here.
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE, false);
    const full: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      deviceAssertion: { audiences: [ALLOWED_AUDIENCE] },
      mcpToolsets: {
        [READ_TOOLSET]: { mcpServers: { [READ_SERVER]: { command: '/opt/salesko/read', args: ['--stdio'] } } },
        [PROPOSE_TOOLSET]: { mcpServers: { [PROPOSE_SERVER]: { command: '/opt/salesko/propose' } } },
      },
      ...config,
    };
    const signer = { count: 0 };
    const built = buildDaemonWithAdapters(full, [adapter], {}, {
      onIssued: () => {
        signer.count += 1;
      },
    });
    createdDaemons.push(built);
    await built.pair('pairing-code');
    await built.start();
    // Contract §8.1: the task lane is gated on a deployment declaration this
    // daemon reads asynchronously, AFTER the connection settles, so the lane is
    // shut until that read lands. `TestServer` declares
    // `host-mcp-task-context` by default, and the re-published `conn.hello`
    // carrying the capability string is this daemon's own statement that it has
    // read the declaration — the only observable that is not a guess about
    // timing. Cases that want the lane CLOSED call `awaitCapabilityRead`
    // instead.
    await server.waitFor(
      (envelope) =>
        envelope.type === 'conn.hello' &&
        hasTaskCapability(envelope),
    );
    return { daemon: built, config: full, storeDir, adapter, signer };
  }

  /** Capability strings on a `conn.hello`, whatever else the payload carries. */
  function helloCapabilities(envelope: { payload?: unknown }): readonly string[] {
    const payload = envelope.payload as { capabilities?: unknown } | undefined;
    return Array.isArray(payload?.capabilities) ? (payload.capabilities as string[]) : [];
  }

  function hasTaskCapability(envelope: { payload?: unknown }): boolean {
    return helloCapabilities(envelope).includes(HOST_MCP_TASK_CONTEXT_CAPABILITY);
  }

  /**
   * Settle point for the cases where the lane must stay CLOSED: the daemon has
   * read (or failed to read) the declaration, so "no hello ever advertised the
   * capability" is an assertion about a finished pass rather than about a race.
   */
  async function awaitCapabilityRead(): Promise<void> {
    await vi.waitFor(() =>
      expect(server.httpRequests.some((request) => request.pathname === '/byok/capabilities')).toBe(true),
    );
    // One macrotask past the response write, so the daemon's own handling of it
    // has run. The assertions that follow are about state, not about the wire.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Starts a daemon WITHOUT waiting for the lane to open — for the closed quadrants. */
  async function pairedAndStartedUngated(
    productId: string,
    config: Partial<DaemonConfig> = {},
    waitForRead = true,
  ): Promise<Started> {
    const workspaceRoot = await tmpDir(`byok-task-assert-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-task-assert-${productId}-store-`);
    const hostStorageRoot = await tmpDir(`byok-task-assert-${productId}-home-`);
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE, false);
    const full: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      deviceAssertion: { audiences: [ALLOWED_AUDIENCE] },
      mcpToolsets: {
        [READ_TOOLSET]: { mcpServers: { [READ_SERVER]: { command: '/opt/salesko/read', args: ['--stdio'] } } },
        [PROPOSE_TOOLSET]: { mcpServers: { [PROPOSE_SERVER]: { command: '/opt/salesko/propose' } } },
      },
      ...config,
    };
    const signer = { count: 0 };
    const built = buildDaemonWithAdapters(full, [adapter], {}, {
      onIssued: () => {
        signer.count += 1;
      },
    });
    createdDaemons.push(built);
    await built.pair('pairing-code');
    await built.start();
    if (waitForRead) await awaitCapabilityRead();
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
    throw new Error('expected task_assertion.issue to be refused, but it resolved');
  }

  /** Offers one Agent task with both toolsets and returns the nonces the daemon injected. */
  async function offerAgentTask(
    built: Started,
    taskId: string,
    requiredToolsets: readonly string[] = [READ_TOOLSET, PROPOSE_TOOLSET],
    timeoutMs = 2000,
  ): Promise<Record<string, string>> {
    server.send(
      createEnvelope(
        'task.offer_for_agent',
        {
          instruction: 'qualify the inbound lead',
          policy: { mode: 'auto' },
          runtime: 'pi',
          agentRef: { agentId: AGENT_ID, profileRevision: PROFILE_REVISION },
          requiredToolsets: [...requiredToolsets],
        },
        { taskId, seq: server.nextSeq() },
      ),
    );
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId, timeoutMs);
    await vi.waitFor(() => expect(built.adapter.startCalls.length).toBeGreaterThan(0));
    // One offer per test, so the single start call is this task's.
    const servers = built.adapter.startCalls[0]!.ctx.mcpServers ?? {};
    const tokens: Record<string, string> = {};
    for (const [name, definition] of Object.entries(servers)) {
      const token = definition.env?.BYOK_HOST_TOOLSET_CONTEXT;
      if (token !== undefined) tokens[name] = token;
    }
    return tokens;
  }

  // -------------------------------------------------------------------------
  // §8.1 injection
  // -------------------------------------------------------------------------

  it('injects one distinct nonce per host toolset server and never into a reserved SDK server', async () => {
    const built = await pairedAndStarted('acme-task-inject');
    const tokens = await offerAgentTask(built, 'task-inject');

    expect(Object.keys(tokens).sort()).toEqual([PROPOSE_SERVER, READ_SERVER].sort());
    expect(tokens[READ_SERVER]).not.toBe(tokens[PROPOSE_SERVER]);
    for (const token of Object.values(tokens)) {
      // 32 bytes of CSPRNG, base64url unpadded.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }

    const call = built.adapter.startCalls[0]!;
    const readServer = call.ctx.mcpServers?.[READ_SERVER];
    expect(readServer?.command).toBe('/opt/salesko/read');
    expect(readServer?.args).toEqual(['--stdio']);
    expect(readServer?.env?.BYOK_STORE_DIR).toBe(built.storeDir);
    expect(readServer?.env?.BYOK_PRODUCT_ID).toBe(built.config.productId);
    // No SDK-reserved server is in play here, and nothing but the host toolset
    // servers ever carries the variable.
    for (const [name, definition] of Object.entries(call.ctx.mcpServers ?? {})) {
      if (name !== READ_SERVER && name !== PROPOSE_SERVER) {
        expect(definition.env?.BYOK_HOST_TOOLSET_CONTEXT).toBeUndefined();
      }
    }
    // The nonce never travels to the server, in any envelope.
    for (const token of Object.values(tokens)) {
      expect(JSON.stringify(server.received)).not.toContain(token);
    }
  });

  it('still refuses a host toolset registry that tries to supply its own env', async () => {
    await expect(
      pairedAndStarted('acme-task-hostenv', {
        mcpToolsets: {
          [READ_TOOLSET]: {
            mcpServers: {
              [READ_SERVER]: { command: '/opt/salesko/read', env: { BYOK_HOST_TOOLSET_CONTEXT: 'forged' } },
            },
          },
        },
      } as Partial<DaemonConfig>),
    ).rejects.toThrow(/only command and args/);
  });

  // -------------------------------------------------------------------------
  // Happy path — claims come from the registry, never from params
  // -------------------------------------------------------------------------

  it('mints a task assertion whose task/agentRef/toolset claims come from the registry entry', async () => {
    const built = await pairedAndStarted('acme-task-ok');
    const tokens = await offerAgentTask(built, 'task-ok');
    const client = await control(built.storeDir, built.config.productId);
    const record = await readDeviceRecord(built.storeDir);

    const result = await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
      contextToken: tokens[READ_SERVER],
      audience: ALLOWED_AUDIENCE,
    });
    const envelope = parseTaskAssertionEnvelope(result.assertion);
    expect(envelope.schema).toBe(TASK_ASSERTION_SCHEMA_ID);

    const claims = await verifyTaskAssertion(envelope, {
      verifier: nodeVerifier,
      lookupDevice: lookupFromStore(built.storeDir),
      now: new Date(envelope.protected.issuedAt),
    });
    expect(claims).toBeDefined();
    expect(claims?.taskId).toBe('task-ok');
    expect(claims?.agentRef).toEqual({ agentId: AGENT_ID, profileRevision: PROFILE_REVISION });
    expect(claims?.toolsetId).toBe(READ_TOOLSET);
    expect(claims?.audience).toBe(ALLOWED_AUDIENCE);
    expect(claims?.deviceId).toBe(record.deviceId);
    expect(claims?.productId).toBe(built.config.productId);
    expect(claims?.issuer).toBe(new URL(server.url).origin);
    expect(result.expiresAt).toBe(envelope.protected.expiresAt);
    // TTL inherited from the device lane's configured default, not a second formula.
    expect(Date.parse(envelope.protected.expiresAt) - Date.parse(envelope.protected.issuedAt)).toBe(120_000);

    // The other server's nonce yields the other toolset, same task.
    const other = await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
      contextToken: tokens[PROPOSE_SERVER],
      audience: ALLOWED_AUDIENCE,
    });
    expect(parseTaskAssertionEnvelope(other.assertion).protected.toolsetId).toBe(PROPOSE_TOOLSET);
    expect(built.signer.count).toBe(2);
  });

  it('mints a fresh jti on every call and caches nothing', async () => {
    const built = await pairedAndStarted('acme-task-fresh');
    const tokens = await offerAgentTask(built, 'task-fresh');
    const client = await control(built.storeDir, built.config.productId);

    const first = parseTaskAssertionEnvelope(
      (await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
        contextToken: tokens[READ_SERVER],
        audience: ALLOWED_AUDIENCE,
      })).assertion,
    );
    const second = parseTaskAssertionEnvelope(
      (await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
        contextToken: tokens[READ_SERVER],
        audience: ALLOWED_AUDIENCE,
      })).assertion,
    );

    expect(first.protected.jti).not.toBe(second.protected.jti);
    expect(first.signature).not.toBe(second.signature);
    expect(second.protected.taskId).toBe(first.protected.taskId);
    expect(built.signer.count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  it('answers context_token_invalid for a token this daemon never issued, and signs nothing', async () => {
    const built = await pairedAndStarted('acme-task-unknown');
    await offerAgentTask(built, 'task-unknown');
    const client = await control(built.storeDir, built.config.productId);

    for (const contextToken of ['a'.repeat(43), 'not-a-nonce', 'x']) {
      const err = await expectControlError(
        client.request('task_assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE }),
      );
      expect(err.code).toBe('context_token_invalid');
    }
    expect(built.signer.count).toBe(0);
  });

  it('rejects any params shape that is not exactly {contextToken,audience}', async () => {
    const built = await pairedAndStarted('acme-task-shape');
    const tokens = await offerAgentTask(built, 'task-shape');
    const client = await control(built.storeDir, built.config.productId);
    const contextToken = tokens[READ_SERVER]!;

    const malformed: readonly unknown[] = [
      undefined,
      {},
      { contextToken },
      { audience: ALLOWED_AUDIENCE },
      // A caller may not name the task, the Agent, or the toolset: those come
      // from the registry entry alone.
      { contextToken, audience: ALLOWED_AUDIENCE, taskId: 'task-shape' },
      { contextToken, audience: ALLOWED_AUDIENCE, agentRef: { agentId: AGENT_ID, profileRevision: PROFILE_REVISION } },
      { contextToken, audience: ALLOWED_AUDIENCE, toolsetId: PROPOSE_TOOLSET },
      { contextToken, audience: ALLOWED_AUDIENCE, ttlMs: 900_000 },
      { contextToken: '', audience: ALLOWED_AUDIENCE },
      { contextToken: 42, audience: ALLOWED_AUDIENCE },
      { contextToken: 'x'.repeat(257), audience: ALLOWED_AUDIENCE },
      { contextToken, audience: '' },
      { contextToken, audience: 'a'.repeat(257) },
    ];
    for (const params of malformed) {
      const err = await expectControlError(client.request('task_assertion.issue', params));
      expect(err.code, `params ${JSON.stringify(params)} must be a bad_request`).toBe('bad_request');
    }
    expect(built.signer.count).toBe(0);
  });

  it('denies an audience outside the allowlist before it ever consults the registry', async () => {
    const built = await pairedAndStarted('acme-task-audience');
    const tokens = await offerAgentTask(built, 'task-audience');
    const client = await control(built.storeDir, built.config.productId);

    for (const audience of ['salesko-api.evil.com', 'salesko-ap', 'SALESKO-API', ' salesko-api']) {
      const err = await expectControlError(
        client.request('task_assertion.issue', { contextToken: tokens[READ_SERVER], audience }),
      );
      expect(err.code).toBe('audience_denied');
      expect(err.message).not.toContain(ALLOWED_AUDIENCE);
    }
    // An unknown token with a denied audience answers audience_denied too — the
    // allowlist gate runs first, so a refusal is not a token oracle.
    const probe = await expectControlError(
      client.request('task_assertion.issue', { contextToken: 'b'.repeat(43), audience: 'salesko-api.evil.com' }),
    );
    expect(probe.code).toBe('audience_denied');
    expect(built.signer.count).toBe(0);
  });

  it('answers assertion_disabled first when the broker is off at all', async () => {
    // `assertion_disabled` is gate 1 and `capability_undeclared` is gate 2, so
    // a daemon that cannot sign never advertises the lane and never reaches the
    // capability check — hence the ungated start: there is no hello to wait for.
    const built = await pairedAndStartedUngated('acme-task-off', { deviceAssertion: undefined });
    const tokens = await offerAgentTask(built, 'task-off');
    const client = await control(built.storeDir, built.config.productId);

    for (const params of [
      undefined,
      {},
      { contextToken: tokens[READ_SERVER], audience: ALLOWED_AUDIENCE },
      { contextToken: 'unknown', audience: 'other' },
    ]) {
      const err = await expectControlError(client.request('task_assertion.issue', params));
      expect(err.code).toBe('assertion_disabled');
    }
    expect(built.signer.count).toBe(0);
  });

  it('refuses every task assertion once a shutdown has been requested', async () => {
    const built = await pairedAndStarted('acme-task-shutdown');
    const tokens = await offerAgentTask(built, 'task-shutdown');
    const client = await control(built.storeDir, built.config.productId);

    await client.request('shutdown', { reason: 'operator' });
    const err = await expectControlError(
      client.request('task_assertion.issue', { contextToken: tokens[READ_SERVER], audience: ALLOWED_AUDIENCE }),
    );
    expect(err.code).toBe('shutting_down');
    expect(built.signer.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC11 / I12 — the daemon's second fail-closed layer
  // -------------------------------------------------------------------------

  it('AC11: a cancelled task can mint no further assertion, and its token dies with its cleanup', async () => {
    const built = await pairedAndStarted('acme-task-cancel');
    const tokens = await offerAgentTask(built, 'task-cancel');
    const client = await control(built.storeDir, built.config.productId);
    const contextToken = tokens[READ_SERVER]!;

    // Authority exists right up to the cancel.
    await client.request<TaskAssertionIssueResult>('task_assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE });
    expect(built.signer.count).toBe(1);

    // Hold the session's teardown open so the post-cancel, pre-cleanup window
    // is observable rather than a race.
    const release = built.adapter.sessions[0]!.blockClose();
    server.send(createEnvelope('task.cancel', { reason: 'operator' }, { taskId: 'task-cancel', seq: server.nextSeq() }));
    await server.waitFor((envelope) => envelope.type === 'task.cancelled');

    const revoked = await expectControlError(
      client.request('task_assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE }),
    );
    expect(revoked.code).toBe('context_revoked');

    release();
    // Once the task's resources are cleaned up the entry is gone entirely, and
    // the refusal is indistinguishable from a token that never existed.
    await vi.waitFor(async () => {
      const gone = await expectControlError(
        client.request('task_assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE }),
      );
      expect(gone.code).toBe('context_token_invalid');
    });
    expect(built.signer.count).toBe(1);
  });

  it('AC11: reaching a terminal without a cancel revokes the task lane just the same', async () => {
    const built = await pairedAndStarted('acme-task-terminal');
    const tokens = await offerAgentTask(built, 'task-terminal');
    const client = await control(built.storeDir, built.config.productId);
    const contextToken = tokens[READ_SERVER]!;

    const release = built.adapter.sessions[0]!.blockClose();
    built.adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((envelope) => envelope.type === 'task.complete');

    const err = await expectControlError(
      client.request('task_assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE }),
    );
    expect(err.code).toBe('context_revoked');
    release();
    expect(built.signer.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Zero interchange between the two lanes
  // -------------------------------------------------------------------------

  it('keeps the device lane and the task lane strictly non-interchangeable', async () => {
    const built = await pairedAndStarted('acme-task-lanes');
    const tokens = await offerAgentTask(built, 'task-lanes');
    const client = await control(built.storeDir, built.config.productId);
    const contextToken = tokens[READ_SERVER]!;

    // The device method rejects a context token outright.
    expect(
      (await expectControlError(client.request('assertion.issue', { contextToken, audience: ALLOWED_AUDIENCE }))).code,
    ).toBe('bad_request');
    // The task method rejects a bare device request outright.
    expect(
      (await expectControlError(client.request('task_assertion.issue', { audience: ALLOWED_AUDIENCE }))).code,
    ).toBe('bad_request');

    // And the two methods mint different envelope kinds over different domains.
    const device = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    const task = await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
      contextToken,
      audience: ALLOWED_AUDIENCE,
    });
    expect((device.assertion as { schema: string }).schema).toBe(DEVICE_ASSERTION_SCHEMA_ID);
    expect((task.assertion as { schema: string }).schema).toBe(TASK_ASSERTION_SCHEMA_ID);
    // A device envelope is not a degraded task envelope.
    expect(() => parseTaskAssertionEnvelope(device.assertion)).toThrow();
  });

  // -------------------------------------------------------------------------
  // The nonce is never observable outside the child it was injected into
  // -------------------------------------------------------------------------

  it('never writes the context token to the observer feed, the stdout line, or the audit log', async () => {
    const built = await pairedAndStarted('acme-task-leak');
    built.daemon.subscribe(createAuditAppender(built.storeDir));
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    const tokens = await offerAgentTask(built, 'task-leak');
    const client = await control(built.storeDir, built.config.productId);
    const contextToken = tokens[READ_SERVER]!;

    const issued = await client.request<TaskAssertionIssueResult>('task_assertion.issue', {
      contextToken,
      audience: ALLOWED_AUDIENCE,
    });
    await expectControlError(client.request('task_assertion.issue', { contextToken: 'c'.repeat(43), audience: ALLOWED_AUDIENCE }));
    unsubscribe();

    const envelope = parseTaskAssertionEnvelope(issued.assertion);
    const assertionEvents = events.filter((event) => event.kind === 'device-assertion');
    expect(assertionEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of assertionEvents) {
      expect(JSON.stringify(event)).not.toContain(contextToken);
      expect(formatDaemonEventLine(event)).not.toContain(contextToken);
    }
    // The lane is recorded so an incident can tell the two credential kinds apart.
    const taskIssued = assertionEvents.find((event) => event.result === 'issued');
    expect(taskIssued).toMatchObject({ lane: 'task', taskId: 'task-leak', jti: envelope.protected.jti });

    const logPath = auditLogPath(built.storeDir);
    await vi.waitFor(async () => {
      expect(await fs.readFile(logPath, 'utf8')).toContain(`"jti":"${envelope.protected.jti}"`);
    });
    const raw = await fs.readFile(logPath, 'utf8');
    expect(raw).not.toContain(contextToken);
    expect(raw).not.toContain('"signature"');
    expect(raw).not.toContain(envelope.signature);
    expect(raw).toContain('"lane":"task"');
  });
  // -------------------------------------------------------------------------
  // §8.1 capability gate — the two channels, and the four quadrants of the one
  // this daemon controls
  // -------------------------------------------------------------------------

  const DECLARED = { schema: 'byok-capabilities-v1', version: 1, capabilities: [HOST_MCP_TASK_CONTEXT_CAPABILITY] };
  // A real declaration that simply withholds this one capability. Deliberately
  // not `presence.hints`, which would start a heartbeat these cases never asked
  // for and make them assert about two features at once.
  const WITHOUT = { schema: 'byok-capabilities-v1', version: 3, capabilities: ['events.longpoll'] };

  it('waits for the first declaration before freezing host toolset nonces', async () => {
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    const built = await pairedAndStartedUngated('acme-cap-first-offer', {}, false);
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    const pending = offerAgentTask(built, 'task-before-declaration');
    try {
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'offered')).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(built.adapter.startCalls).toHaveLength(0);
      release();
      const tokens = await pending;
      expect(Object.keys(tokens).sort()).toEqual([PROPOSE_SERVER, READ_SERVER].sort());
    } finally {
      release();
      await pending;
      unsubscribe();
    }
  });

  it('bounds a hung declaration, reports timeout, and ignores its late success', async () => {
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    const built = await pairedAndStartedUngated('acme-cap-timeout', {}, false);
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    try {
      expect(await offerAgentTask(built, 'task-discovery-timeout', undefined, 8000)).toEqual({});
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'device-assertion', lane: 'task', taskId: 'task-discovery-timeout', reason: 'capability_discovery_timeout' }),
      ]));
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.received.some((event) => event.type === 'conn.hello' && hasTaskCapability(event))).toBe(false);
      const client = await control(built.storeDir, built.config.productId);
      expect((await expectControlError(client.request('task_assertion.issue', { contextToken: 'x'.repeat(43), audience: ALLOWED_AUDIENCE }))).code).toBe('capability_undeclared');
    } finally {
      release();
      unsubscribe();
    }
  }, 12000);

  it('reports unreadable declarations separately from an explicit missing capability', async () => {
    server.setCapabilityDeclaration({ malformed: true });
    const built = await pairedAndStartedUngated('acme-cap-unreadable');
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    try {
      expect(await offerAgentTask(built, 'task-discovery-failed')).toEqual({});
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'device-assertion', lane: 'task', taskId: 'task-discovery-failed', reason: 'capability_discovery_failed' }),
      ]));
    } finally { unsubscribe(); }
  });

  it('waits for the new connection declaration instead of borrowing the prior one', async () => {
    const built = await pairedAndStarted('acme-cap-reconnect');
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    server.setFailEventsPolls(true);
    await vi.waitFor(() => expect(built.daemon.status().connected).toBe(false), { timeout: 5000 });
    server.setFailEventsPolls(false);
    await vi.waitFor(() => expect(server.httpRequests.filter((r) => r.pathname === '/byok/capabilities').length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    const pending = offerAgentTask(built, 'task-after-reconnect');
    try {
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'offered')).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(built.adapter.startCalls).toHaveLength(0);
      release();
      expect(Object.keys(await pending).sort()).toEqual([PROPOSE_SERVER, READ_SERVER].sort());
    } finally { release(); await pending; unsubscribe(); }
  }, 15000);

  it('does not hold a task without host toolsets behind discovery', async () => {
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    const built = await pairedAndStartedUngated('acme-cap-no-tools', {}, false);
    try {
      server.send(createEnvelope('task.offer_for_agent', {
        instruction: 'no host tools', policy: { mode: 'auto' }, runtime: 'pi',
        agentRef: { agentId: AGENT_ID, profileRevision: PROFILE_REVISION },
      }, { taskId: 'task-no-host-tools', seq: server.nextSeq() }));
      await server.waitFor((event) => event.type === 'task.started' && event.task_id === 'task-no-host-tools');
      expect(built.adapter.startCalls).toHaveLength(1);
    } finally { release(); }
  });

  it('cancellation interrupts discovery admission without starting the task', async () => {
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    const built = await pairedAndStartedUngated('acme-cap-cancel-wait', {}, false);
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    try {
      server.send(createEnvelope('task.offer_for_agent', {
        instruction: 'wait then cancel', policy: { mode: 'auto' }, runtime: 'pi',
        agentRef: { agentId: AGENT_ID, profileRevision: PROFILE_REVISION }, requiredToolsets: [READ_TOOLSET],
      }, { taskId: 'task-cancel-discovery', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'offered')).toBe(true));
      server.send(createEnvelope('task.cancel', { reason: 'operator' }, { taskId: 'task-cancel-discovery', seq: server.nextSeq() }));
      const declined = await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'task-cancel-discovery');
      expect(declined.payload).toMatchObject({ retryable: false });
      expect(built.adapter.startCalls).toHaveLength(0);
    } finally { release(); unsubscribe(); }
  });

  it('shutdown releases a pending offer without starting its runtime', async () => {
    let release!: () => void;
    server.setCapabilityResponseGate(new Promise<void>((resolve) => { release = resolve; }));
    const built = await pairedAndStartedUngated('acme-cap-stop', {}, false);
    const events: DaemonEvent[] = [];
    const unsubscribe = built.daemon.subscribe((event) => events.push(event));
    try {
      server.send(createEnvelope('task.offer_for_agent', {
        instruction: 'wait then stop', policy: { mode: 'auto' }, runtime: 'pi',
        agentRef: { agentId: AGENT_ID, profileRevision: PROFILE_REVISION }, requiredToolsets: [READ_TOOLSET],
      }, { taskId: 'task-stop-during-discovery', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(events.some((event) => event.kind === 'offered')).toBe(true));
      await built.daemon.stop();
      expect(built.adapter.startCalls).toHaveLength(0);
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(built.adapter.startCalls).toHaveLength(0);
    } finally { release(); unsubscribe(); }
  });

  it('advertises host-mcp-task-context only when signing is enabled AND the deployment declares it', async () => {
    // Quadrant 1 — enabled x declared. The only one that advertises.
    server.setCapabilityDeclaration(DECLARED);
    const enabledAndDeclared = await pairedAndStarted('acme-cap-both');
    expect(
      server.received.some((envelope) => envelope.type === 'conn.hello' && hasTaskCapability(envelope)),
    ).toBe(true);
    await enabledAndDeclared.daemon.stop();
  });

  it('advertises nothing when the deployment declares the capability but this daemon issues no assertions', async () => {
    // Quadrant 2 — declared, signing disabled. The deployment's half alone is
    // not the gate: a daemon that cannot sign cannot serve a lane made of
    // signatures, and saying otherwise would promise authority it cannot mint.
    server.setCapabilityDeclaration(DECLARED);
    const built = await pairedAndStartedUngated('acme-cap-nosign', { deviceAssertion: undefined });

    expect(server.received.some((envelope) => envelope.type === 'conn.hello')).toBe(true);
    expect(server.received.some((envelope) => envelope.type === 'conn.hello' && hasTaskCapability(envelope))).toBe(false);
    await built.daemon.stop();
  });

  it('advertises nothing when this daemon can sign but the deployment withholds the capability', async () => {
    // Quadrant 3 — enabled, undeclared. §8.3: the answer is `unavailable`, and
    // there is no device-lane substitute to fall back to.
    server.setCapabilityDeclaration(WITHOUT);
    const built = await pairedAndStartedUngated('acme-cap-nodecl');

    expect(server.received.some((envelope) => envelope.type === 'conn.hello')).toBe(true);
    expect(server.received.some((envelope) => envelope.type === 'conn.hello' && hasTaskCapability(envelope))).toBe(false);
    await built.daemon.stop();
  });

  it('advertises nothing when neither half holds, and treats an unreadable declaration as nothing', async () => {
    // Quadrant 4 — neither. A deployment that serves no declaration at all is
    // exactly as informative as one that declares nothing (ADR-010): no probe,
    // no 404-means-old reading, no assumed capability.
    server.setCapabilityDeclaration(undefined);
    const built = await pairedAndStartedUngated('acme-cap-neither', { deviceAssertion: undefined });

    expect(server.received.some((envelope) => envelope.type === 'conn.hello')).toBe(true);
    expect(server.received.some((envelope) => envelope.type === 'conn.hello' && hasTaskCapability(envelope))).toBe(false);
    await built.daemon.stop();
  });

  it('refuses task_assertion.issue and injects no nonce when the capability is undeclared', async () => {
    server.setCapabilityDeclaration(WITHOUT);
    const built = await pairedAndStartedUngated('acme-cap-refuse');
    const tokens = await offerAgentTask(built, 'task-undeclared');

    // §8.2(1): the MCP child is started with no `BYOK_HOST_TOOLSET_CONTEXT` at
    // all, so a standalone run fails explicitly for want of a token rather than
    // reaching for some other identity.
    expect(tokens).toEqual({});
    const servers = built.adapter.startCalls[0]?.ctx.mcpServers ?? {};
    expect(Object.keys(servers).sort()).toEqual([PROPOSE_SERVER, READ_SERVER].sort());
    for (const definition of Object.values(servers)) {
      expect(definition.env?.BYOK_HOST_TOOLSET_CONTEXT).toBeUndefined();
    }

    // And the RPC says so in its own right, ahead of the params check — a
    // caller that guessed a token learns nothing about whether it was real.
    const client = await control(built.storeDir, built.config.productId);
    const refused = await expectControlError(
      client.request('task_assertion.issue', { contextToken: 'x'.repeat(43), audience: ALLOWED_AUDIENCE }),
    );
    expect(refused.code).toBe('capability_undeclared');
    const malformed = await expectControlError(client.request('task_assertion.issue', { nonsense: true }));
    expect(malformed.code).toBe('capability_undeclared');
    expect(built.signer.count).toBe(0);
  });

  it('still mints the device lane while the task lane is undeclared', async () => {
    // §8.1's other half: `device-only assertion 可服务其独立现有消费者`. The task
    // lane's capability gate withdraws the TASK lane, and nothing else.
    server.setCapabilityDeclaration(WITHOUT);
    const built = await pairedAndStartedUngated('acme-cap-device-lane');
    const client = await control(built.storeDir, built.config.productId);

    const device = await client.request<AssertionIssueResult>('assertion.issue', { audience: ALLOWED_AUDIENCE });
    expect((device.assertion as { schema: string }).schema).toBe(DEVICE_ASSERTION_SCHEMA_ID);
  });

  // -------------------------------------------------------------------------
  // Refusal wording and refusal codes (slice 2 follow-ups)
  // -------------------------------------------------------------------------

  it('names the contextToken bound in the bad_request wording, not the audience bound', async () => {
    const built = await pairedAndStarted('acme-task-badreq-wording');
    const client = await control(built.storeDir, built.config.productId);

    const refused = await expectControlError(
      client.request('task_assertion.issue', { contextToken: 'y'.repeat(257), audience: ALLOWED_AUDIENCE }),
    );
    expect(refused.code).toBe('bad_request');
    // 256 is the contextToken bound; the audience bound is a different number
    // and quoting it here would send a caller to fix the wrong field.
    expect(refused.message).toContain(`contextToken at most ${TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES}`);
    expect(refused.message).toContain(`audience at most ${ASSERTION_AUDIENCE_MAX_BYTES}`);
    // Both fields are named, each against its OWN bound. The old wording quoted
    // the audience bound for both, which sends a caller to fix the wrong field
    // the moment the two numbers stop coinciding.
    expect(refused.message).toMatch(/contextToken at most \d+ and audience at most \d+/);
  });

  it('keeps one refusal vocabulary, with the capability gate ahead of the device gates', async () => {
    // The order is the handler's own check order, and the list is what
    // `assertion-client.ts` maps for a caller. The capability gate sits second
    // because a daemon that cannot serve this lane has nothing to say about the
    // shape of a request for it — see the `capability_undeclared` case above,
    // where a malformed body still answers `capability_undeclared`.
    expect([...TASK_ASSERTION_ISSUE_ERROR_CODES]).toEqual([
      'assertion_disabled',
      'capability_undeclared',
      'bad_request',
      'audience_denied',
      'shutting_down',
      'revoked',
      'not_paired',
      'context_token_invalid',
      'context_revoked',
    ]);
  });

  it('answers context_token_invalid for an unknown token on a live daemon', async () => {
    // The reachable half of the post-sign re-read's refusal vocabulary: an
    // unknown token is `context_token_invalid`, never `context_revoked`, which
    // would claim a registry entry existed and its task's authority ended. The
    // post-sign re-read now derives its code from the same lookup shape, so the
    // two reads cannot answer differently for the same state.
    const built = await pairedAndStarted('acme-task-unknown-token');
    await offerAgentTask(built, 'task-unknown-token');
    const client = await control(built.storeDir, built.config.productId);

    const refused = await expectControlError(
      client.request('task_assertion.issue', { contextToken: 'z'.repeat(43), audience: ALLOWED_AUDIENCE }),
    );
    expect(refused.code).toBe('context_token_invalid');
  });
});
