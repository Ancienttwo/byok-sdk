import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  TASK_ASSERTION_SCHEMA_ID,
  deviceAssertionSigningInput,
  taskAssertionSigningInput,
  type DeviceAssertionClaims,
  type DeviceAssertionReplayAuthority,
  type TaskAssertionClaims,
} from '@byok-sdk/core';
import { CLOUD_CAPABILITIES } from '@byok-sdk/cloud';
import { createEnvelope, type AgentRef, type ToolsetId } from '@byok-sdk/protocol';
import {
  createByokServer,
  HostMcpTaskAssertionError,
  verifyHostMcpTaskAssertion,
  type ByokServer,
  type CreateByokServerOptions,
} from '../index';
import { isSqliteAvailable } from '../sqlite-support';
import {
  connectFakeDaemonLongPoll,
  generateFakeDeviceIdentity,
  nextEnvelope,
  startServer,
  stopServer,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
  TEST_CLAIMED_EXECUTOR,
  type FakeDeviceIdentity,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
const SHORT_HOLD_MS = 200;
const AUDIENCE = 'byok-desktop-widgets';
const WIDGET_TOOLSET: ToolsetId = 'desktop.widgets';
const FINANCE_TOOLSET: ToolsetId = 'desktop.finance';

let jtiCounter = 0;
function nextJti(): string {
  jtiCounter += 1;
  return `JTI_${String(jtiCounter).padStart(18, '0')}`;
}

function signTaskAssertion(
  identity: FakeDeviceIdentity,
  overrides: Partial<TaskAssertionClaims> & {
    issuer: string;
    deviceId: string;
    taskId: string;
  },
) {
  const now = Date.now();
  const claims: TaskAssertionClaims = {
    version: 1,
    productId: PRODUCT_ID,
    audience: AUDIENCE,
    jti: nextJti(),
    issuedAt: new Date(now - 5_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    agentRef: TEST_AGENT_REF,
    toolsetId: WIDGET_TOOLSET,
    ...overrides,
  };
  return {
    schema: TASK_ASSERTION_SCHEMA_ID,
    algorithm: 'ed25519' as const,
    protected: claims,
    signature: identity.sign(Buffer.from(taskAssertionSigningInput(claims)).toString('utf8')),
  };
}

function signDeviceAssertion(
  identity: FakeDeviceIdentity,
  overrides: Partial<DeviceAssertionClaims> & {
    issuer: string;
    deviceId: string;
  },
) {
  const now = Date.now();
  const claims: DeviceAssertionClaims = {
    version: 1,
    productId: PRODUCT_ID,
    audience: AUDIENCE,
    jti: nextJti(),
    issuedAt: new Date(now - 5_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
  return {
    schema: DEVICE_ASSERTION_SCHEMA_ID,
    algorithm: 'ed25519' as const,
    protected: claims,
    signature: identity.sign(Buffer.from(deviceAssertionSigningInput(claims)).toString('utf8')),
  };
}

describe('host-mcp-task-context verification (§8.2)', () => {
  const servers: HttpServer[] = [];
  const byoks: ByokServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const instance of byoks.splice(0)) await instance.close();
    for (const http of servers.splice(0)) await stopServer(http);
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function boot(
    opts: Partial<CreateByokServerOptions> = {},
  ): Promise<{ byok: ByokServer; baseUrl: string; issuer: string }> {
    const instance = createByokServer({
      productId: PRODUCT_ID,
      longPollHoldMs: SHORT_HOLD_MS,
      hostMcpTaskContext: { enabled: true },
      ...opts,
    });
    byoks.push(instance);
    const started = await startServer(instance);
    servers.push(started.server);
    return { byok: instance, baseUrl: started.baseUrl, issuer: new URL(started.baseUrl).origin };
  }

  async function connectDaemon(
    started: { byok: ByokServer; baseUrl: string },
    deviceName = 'laptop-a',
  ): Promise<FakeLongPollDaemon> {
    return connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName,
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'toolset-selection',
        'terminal-projection-selection',
        'agent-egress-fresh-session',
        CLOUD_CAPABILITIES.hostMcpTaskContext,
      ],
    });
  }

  async function startActiveTask(
    started: { byok: ByokServer; baseUrl: string },
    daemon: FakeLongPollDaemon,
    options: {
      requiredToolsets?: ToolsetId[];
      agentRef?: AgentRef;
      claim?: boolean;
      running?: boolean;
      viaExecutionSubmit?: boolean;
    } = {},
  ): Promise<string> {
    const agentRef = options.agentRef ?? TEST_AGENT_REF;
    const taskId = options.viaExecutionSubmit
      ? (await started.byok.executions.submit({
          taskId: `exec-${globalThis.crypto.randomUUID()}`,
          deviceId: daemon.deviceId,
          payload: {
            instruction: 'render widget',
            target: { lane: 'auto' },
            agentRef,
            session: { mode: 'fresh' },
            egressPolicy: {
              policyRevision: '1',
              activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262_144 },
              reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
              transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' },
            },
            terminalProjection: { mode: 'none' },
            ...(options.requiredToolsets === undefined ? {} : { requiredToolsets: options.requiredToolsets }),
          },
        })).taskId
      : (await started.byok.dispatch({
          ...TEST_AGENT_DISPATCH,
          deviceId: daemon.deviceId,
          agentRef,
          instruction: 'render widget',
          ...(options.requiredToolsets === undefined ? {} : { requiredToolsets: options.requiredToolsets }),
        })).taskId;

    const offer = await nextEnvelope(daemon);
    expect(offer.type).toBe('task.offer');

    if (options.claim ?? true) {
      const claimRes = await daemon.send(
        createEnvelope('task.claim', { deviceId: daemon.deviceId, agentRef, executor: TEST_CLAIMED_EXECUTOR }, { taskId }),
      );
      expect(claimRes.status).toBe(200);
      expect(await claimRes.json()).toMatchObject({ accepted: 1 });
    }
    if (options.running ?? true) {
      const startedRes = await daemon.send(createEnvelope('task.started', {}, { taskId }));
      expect(startedRes.status).toBe(200);
      expect(await startedRes.json()).toMatchObject({ accepted: 1 });
    }
    return taskId;
  }

  it('keeps host-mcp-task-context disabled by default with no capability, no replay maintenance, and closed verification', async () => {
    const started = await boot({ hostMcpTaskContext: undefined });
    const capabilitiesRes = await started.byok.hono.request('/byok/capabilities');
    const declared = (await capabilitiesRes.json()) as { capabilities: string[] };
    expect(declared.capabilities).not.toContain(CLOUD_CAPABILITIES.hostMcpTaskContext);

    const maintenance = await started.byok.maintenance.runNow();
    expect(maintenance.steps.find((step) => step.step === 'deviceAssertionReplay')).toEqual({
      step: 'deviceAssertionReplay',
      status: 'not-configured',
    });

    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: undefined,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_context_disabled' });

    await expect(
      verifyHostMcpTaskAssertion({} as ByokServer, {
        assertion: undefined,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_context_disabled' });
  });

  it('refuses invalid hostMcpTaskContext option shapes at construction', () => {
    expect(() =>
      createByokServer({ productId: PRODUCT_ID, hostMcpTaskContext: { enabled: false } as never }),
    ).toThrowError(expect.objectContaining({ code: 'coordination_input_invalid' }));

    expect(() =>
      createByokServer({
        productId: PRODUCT_ID,
        hostMcpTaskContext: { enabled: true, replay: {} as never },
      }),
    ).toThrowError(expect.objectContaining({ code: 'coordination_input_invalid' }));
  });

  it('accepts a valid assertion for an active claimed or running task with the toolset in its frozen offer', async () => {
    const storage: CreateByokServerOptions['storage'] = isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1'
      ? (() => {
          const dir = mkdtempSync(join(tmpdir(), 'byok-task-ctx-'));
          directories.push(dir);
          return { kind: 'sqlite', path: join(dir, 'server.sqlite') };
        })()
      : undefined;
    const started = await boot(storage === undefined ? {} : { storage });
    const daemon = await connectDaemon(started);

    const dispatchedTaskId = await startActiveTask(started, daemon, {
      requiredToolsets: [WIDGET_TOOLSET],
      claim: true,
      running: false,
    });
    const firstAssertion = signTaskAssertion(daemon.identity, {
      issuer: started.issuer,
      deviceId: daemon.deviceId,
      taskId: dispatchedTaskId,
    });
    const verifiedClaimed = await verifyHostMcpTaskAssertion(started.byok, {
      assertion: firstAssertion,
      issuer: started.issuer,
      audience: AUDIENCE,
      toolset: WIDGET_TOOLSET,
    });
    expect(verifiedClaimed).toEqual({
      lane: 'task',
      device: {
        kind: 'device',
        tenantId: daemon.tenantId,
        productId: PRODUCT_ID,
        deviceId: daemon.deviceId,
      },
      issuer: started.issuer,
      audience: AUDIENCE,
      jti: firstAssertion.protected.jti,
      issuedAt: firstAssertion.protected.issuedAt,
      expiresAt: firstAssertion.protected.expiresAt,
      taskId: dispatchedTaskId,
      agentRef: TEST_AGENT_REF,
      toolsetId: WIDGET_TOOLSET,
    });

    // Fresh JTI on the same active task succeeds; executions.submit path also verifies identically.
    const submittedTaskId = await startActiveTask(started, daemon, {
      requiredToolsets: [WIDGET_TOOLSET, FINANCE_TOOLSET],
      viaExecutionSubmit: true,
    });
    const secondAssertion = signTaskAssertion(daemon.identity, {
      issuer: started.issuer,
      deviceId: daemon.deviceId,
      taskId: submittedTaskId,
    });
    const verifiedRunning = await verifyHostMcpTaskAssertion(started.byok, {
      assertion: secondAssertion,
      issuer: started.issuer,
      audience: AUDIENCE,
      toolset: WIDGET_TOOLSET,
    });
    expect(verifiedRunning.taskId).toBe(submittedTaskId);

    const maintenance = await started.byok.maintenance.runNow();
    expect(maintenance.steps.find((step) => step.step === 'deviceAssertionReplay')).toMatchObject({
      step: 'deviceAssertionReplay',
      status: 'ok',
    });

    await started.byok.close();
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemon.identity, {
          issuer: started.issuer,
          deviceId: daemon.deviceId,
          taskId: submittedTaskId,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_context_disabled' });
  });

  it('rejects a second use of the same jti with assertion_replayed', async () => {
    const started = await boot();
    const daemon = await connectDaemon(started);
    const taskId = await startActiveTask(started, daemon, { requiredToolsets: [WIDGET_TOOLSET] });

    const assertion = signTaskAssertion(daemon.identity, {
      issuer: started.issuer,
      deviceId: daemon.deviceId,
      taskId,
    });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).resolves.toMatchObject({ taskId, jti: assertion.protected.jti });

    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'assertion_replayed' });
  });

  it.each([undefined, null, ''] as const)('rejects missing assertion (%j) with assertion_missing', async (missing) => {
    const started = await boot();
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: missing,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'assertion_missing' });
  });

  it('rejects invalid, device-lane, expired, wrong-issuer/product, forged, and revoked assertions with assertion_invalid', async () => {
    const started = await boot();
    const daemon = await connectDaemon(started);
    const impostor = generateFakeDeviceIdentity();
    const taskId = await startActiveTask(started, daemon, { requiredToolsets: [WIDGET_TOOLSET] });
    const now = Date.now();

    const invalidCases: Array<[string, unknown]> = [
      ['malformed object', { not: 'an assertion' }],
      ['device assertion envelope (no fallback)', signDeviceAssertion(daemon.identity, { issuer: started.issuer, deviceId: daemon.deviceId })],
      ['forged signature', signTaskAssertion(impostor, { issuer: started.issuer, deviceId: daemon.deviceId, taskId })],
      ['forged signature with wrong audience', signTaskAssertion(impostor, { issuer: started.issuer, deviceId: daemon.deviceId, taskId, audience: 'other-audience' })],
      ['expired window', signTaskAssertion(daemon.identity, { issuer: started.issuer, deviceId: daemon.deviceId, taskId, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString() })],
      ['expired window with wrong audience', signTaskAssertion(daemon.identity, { issuer: started.issuer, deviceId: daemon.deviceId, taskId, audience: 'other-audience', issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString() })],
      ['wrong issuer', signTaskAssertion(daemon.identity, { issuer: 'http://127.0.0.1:1', deviceId: daemon.deviceId, taskId })],
      ['wrong productId', signTaskAssertion(daemon.identity, { issuer: started.issuer, deviceId: daemon.deviceId, taskId, productId: 'other-product' })],
    ];

    for (const [label, assertion] of invalidCases) {
      await expect(
        verifyHostMcpTaskAssertion(started.byok, {
          assertion,
          issuer: started.issuer,
          audience: AUDIENCE,
          toolset: WIDGET_TOOLSET,
        }),
        label,
      ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'assertion_invalid' });
    }

    // Revoked device fails closed as assertion_invalid.
    await started.byok.devices.revoke(daemon.deviceId);
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemon.identity, { issuer: started.issuer, deviceId: daemon.deviceId, taskId }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'assertion_invalid' });
  });

  it('rejects a valid assertion with wrong audience as assertion_audience_mismatch without spending its jti', async () => {
    const started = await boot();
    const daemon = await connectDaemon(started);
    const taskId = await startActiveTask(started, daemon, { requiredToolsets: [WIDGET_TOOLSET] });

    const otherAudienceAssertion = signTaskAssertion(daemon.identity, {
      issuer: started.issuer,
      deviceId: daemon.deviceId,
      taskId,
      audience: 'other-audience',
    });

    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: otherAudienceAssertion,
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'assertion_audience_mismatch' });

    // Rejection happened before replay consumption, so the intended audience can still consume it once.
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: otherAudienceAssertion,
        issuer: started.issuer,
        audience: 'other-audience',
        toolset: WIDGET_TOOLSET,
      }),
    ).resolves.toMatchObject({ audience: 'other-audience', taskId });
  });

  it('rejects unknown, unclaimed, cancelled, ended, cross-device, and mismatched-AgentRef executions with task_inactive', async () => {
    const started = await boot();
    const daemonA = await connectDaemon(started, 'laptop-a');
    const daemonB = await connectDaemon(started, 'laptop-b');

    // Unknown task
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonA.identity, {
          issuer: started.issuer,
          deviceId: daemonA.deviceId,
          taskId: 'task-does-not-exist',
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });

    // Offered but unclaimed task
    const unclaimedTaskId = await startActiveTask(started, daemonA, {
      requiredToolsets: [WIDGET_TOOLSET],
      claim: false,
      running: false,
    });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonA.identity, {
          issuer: started.issuer,
          deviceId: daemonA.deviceId,
          taskId: unclaimedTaskId,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });

    // Active task -> cross-device and wrong AgentRef rejected
    const activeTaskId = await startActiveTask(started, daemonA, { requiredToolsets: [WIDGET_TOOLSET] });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonB.identity, {
          issuer: started.issuer,
          deviceId: daemonB.deviceId,
          taskId: activeTaskId,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });

    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonA.identity, {
          issuer: started.issuer,
          deviceId: daemonA.deviceId,
          taskId: activeTaskId,
          agentRef: { agentId: TEST_AGENT_REF.agentId, profileRevision: 'rev-different' },
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });

    // Host cancel immediately revokes admission
    await started.byok.tasks.cancel(activeTaskId, 'user cancelled');
    expect((await nextEnvelope(daemonA)).type).toBe('task.cancel');
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonA.identity, {
          issuer: started.issuer,
          deviceId: daemonA.deviceId,
          taskId: activeTaskId,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });

    // Device End (task.complete) revokes admission
    const completedTaskId = await startActiveTask(started, daemonA, { requiredToolsets: [WIDGET_TOOLSET] });
    const completeRes = await daemonA.send(
      createEnvelope(
        'task.complete',
        { summary: 'done', executor: TEST_CLAIMED_EXECUTOR, agentRef: TEST_AGENT_REF, sessionRef: 'sess-test' },
        { taskId: completedTaskId },
      ),
    );
    expect(completeRes.status).toBe(200);
    expect(await completeRes.json()).toMatchObject({ accepted: 1 });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemonA.identity, {
          issuer: started.issuer,
          deviceId: daemonA.deviceId,
          taskId: completedTaskId,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'task_inactive' });
  });

  it('rejects calls when the toolset is not in the frozen offer or mismatches the assertion toolsetId', async () => {
    const started = await boot();
    const daemon = await connectDaemon(started);

    // Frozen offer has no requiredToolsets at all
    const noToolsetsTaskId = await startActiveTask(started, daemon);
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemon.identity, {
          issuer: started.issuer,
          deviceId: daemon.deviceId,
          taskId: noToolsetsTaskId,
          toolsetId: WIDGET_TOOLSET,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'toolset_not_offered' });

    // Frozen offer does not include WIDGET_TOOLSET
    const withoutWidgetTaskId = await startActiveTask(started, daemon, {
      requiredToolsets: [FINANCE_TOOLSET],
    });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemon.identity, {
          issuer: started.issuer,
          deviceId: daemon.deviceId,
          taskId: withoutWidgetTaskId,
          toolsetId: WIDGET_TOOLSET,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'toolset_not_offered' });

    // Frozen offer includes both toolsets, but assertion was issued for FINANCE_TOOLSET while Host requires WIDGET_TOOLSET
    const bothTaskId = await startActiveTask(started, daemon, {
      requiredToolsets: [WIDGET_TOOLSET, FINANCE_TOOLSET],
    });
    await expect(
      verifyHostMcpTaskAssertion(started.byok, {
        assertion: signTaskAssertion(daemon.identity, {
          issuer: started.issuer,
          deviceId: daemon.deviceId,
          taskId: bothTaskId,
          toolsetId: FINANCE_TOOLSET,
        }),
        issuer: started.issuer,
        audience: AUDIENCE,
        toolset: WIDGET_TOOLSET,
      }),
    ).rejects.toMatchObject({ name: 'HostMcpTaskAssertionError', code: 'toolset_not_offered' });
  });

  it('fails closed with replay_store_unavailable when the replay authority errors and never downgrades', async () => {
    const cause = new Error('replay database offline');
    const brokenReplay: DeviceAssertionReplayAuthority = {
      collectExpired: async () => {
        throw cause;
      },
      consume: async () => {
        throw cause;
      },
    };
    const started = await boot({ hostMcpTaskContext: { enabled: true, replay: brokenReplay } });
    const daemon = await connectDaemon(started);
    const taskId = await startActiveTask(started, daemon, { requiredToolsets: [WIDGET_TOOLSET] });

    const error = await verifyHostMcpTaskAssertion(started.byok, {
      assertion: signTaskAssertion(daemon.identity, {
        issuer: started.issuer,
        deviceId: daemon.deviceId,
        taskId,
      }),
      issuer: started.issuer,
      audience: AUDIENCE,
      toolset: WIDGET_TOOLSET,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HostMcpTaskAssertionError);
    expect((error as HostMcpTaskAssertionError).code).toBe('replay_store_unavailable');
    expect((error as HostMcpTaskAssertionError).cause).toBe(cause);
  });
});
