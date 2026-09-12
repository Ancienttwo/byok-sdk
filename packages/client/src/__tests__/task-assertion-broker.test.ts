import { createPublicKey, verify as edVerify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  TASK_ASSERTION_SCHEMA_ID,
  parseTaskAssertionEnvelope,
  verifyTaskAssertion,
  type DeviceAssertionDeviceRow,
  type DeviceAssertionVerifier,
} from '@byok-sdk/core';
import { buildDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { ControlError, type AssertionIssueResult, type TaskAssertionIssueResult } from '../daemon/control-protocol';
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
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === taskId);
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
    const built = await pairedAndStarted('acme-task-off', { deviceAssertion: undefined });
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
});
