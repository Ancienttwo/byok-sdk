import { promises as fs, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type ProviderProvisioningReadback } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import {
  ProviderProvisioningNoticeError,
  createProviderProvisioningNoticeProcessor,
  type ProviderProvisioningHandler,
} from '../daemon/provider-provisioning';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * F3 regression: the Host provisioning handler sits next to credential bytes
 * (fetch, HPKE open, OS credential store). Whatever it throws or returns must
 * never reach a daemon log, local state or a serialized error. Only a fixed
 * reason code and the non-secret request id may cross the processor boundary.
 */

const TENANT = 'tenant-redaction';
const REQUEST_ID = '50000000-0000-4000-8000-000000000001';
const CANARY = 'synthetic-provider-key-canary-9b41e2';

function validReadback(deviceId: string): ProviderProvisioningReadback {
  return {
    tenantId: TENANT,
    deviceId,
    requestId: REQUEST_ID,
    disposition: 'recorded',
    completion: {
      outcome: 'rejected',
      requestId: REQUEST_ID,
      operation: 'configure',
      operationGeneration: '1',
      operationDigest: `sha256:${'d'.repeat(64)}`,
      code: 'seal_open_failed',
    },
    completedAt: '2026-09-28T05:00:00.000Z',
  };
}

type HostileCase = readonly [label: string, reason: string, build: (deviceId: string) => ProviderProvisioningHandler];

const HOSTILE_CASES: readonly HostileCase[] = [
  ['canary in Error.message', 'handler_failed', () => async () => {
    throw new Error(`vendor refused key ${CANARY}`);
  }],
  ['canary in a nested cause', 'handler_failed', () => async () => {
    throw new Error('outer transport failure', { cause: new Error('inner', { cause: { apiKey: CANARY } }) });
  }],
  ['canary in enumerable error properties', 'handler_failed', () => async () => {
    throw Object.assign(new Error('keychain write failed'), { request: { secret: CANARY }, stderr: CANARY });
  }],
  ['a thrown non-Error value', 'handler_failed', () => async () => {
    throw { secret: CANARY };
  }],
  ['a malformed readback carrying the canary', 'readback_invalid', (deviceId) => async () =>
    ({ ...validReadback(deviceId), [CANARY]: CANARY, disposition: CANARY }) as unknown as ProviderProvisioningReadback],
];

function everySerialization(error: unknown): string {
  const forms: string[] = [
    inspect(error, { depth: Infinity, showHidden: true, getters: true }),
    String(error),
    JSON.stringify(error) ?? '',
  ];
  if (error instanceof Error) {
    forms.push(error.message, error.stack ?? '', inspect(error.cause, { depth: Infinity, showHidden: true }));
    forms.push(JSON.stringify(Object.getOwnPropertyNames(error).map((name) => [name, (error as unknown as Record<string, unknown>)[name]])));
  }
  return forms.join('\n');
}

describe('provider provisioning processor error boundary', () => {
  it.each(HOSTILE_CASES)('throws a closed, canary-free error for %s', async (_label, reason, build) => {
    const process = createProviderProvisioningNoticeProcessor({
      tenantId: TENANT,
      deviceId: 'device-redaction',
      handler: build('device-redaction'),
    });
    const error = await process({ requestId: REQUEST_ID }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderProvisioningNoticeError);
    const typed = error as ProviderProvisioningNoticeError;
    expect(typed.reason).toBe(reason);
    expect(typed.requestId).toBe(REQUEST_ID);
    expect(typed.cause).toBeUndefined();
    expect(Object.keys(typed)).toEqual([]);
    expect(everySerialization(error)).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// The real daemon log chain: long-poll -> connection manager -> console.
// ---------------------------------------------------------------------------

const servers: TestServer[] = [];
const daemons: Daemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe('daemon log chain for a failing provisioning handler', () => {
  it.each(HOSTILE_CASES)('keeps %s out of console, local state and the cursor', async (_label, reason, build) => {
    const consoleCalls: unknown[][] = [];
    for (const method of ['error', 'warn', 'log', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
    const server = await TestServer.start();
    servers.push(server);
    server.setPairingTenantId('pairing-code', TENANT);
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-provisioning-redaction-store-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-provisioning-redaction-ws-'));
    roots.push(storeDir, workspaceRoot);
    let deviceId = '';
    const daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        hostedJournal: { mode: 'sqlite' as const },
        providerProvisioning: async (notice) => build(deviceId)(notice),
      },
      [new StubRuntimeAdapter()],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    daemons.push(daemon);
    deviceId = (await daemon.pair('pairing-code')).deviceId;
    await daemon.start();
    await server.waitFor((envelope) => envelope.type === 'conn.hello', 5_000);

    const notice = createEnvelope('provider.provisioning.available', { requestId: REQUEST_ID }, { seq: server.nextSeq() });
    server.pushLongPollEvent(notice);
    await vi.waitFor(() => {
      expect(
        consoleCalls.some((args) => String(args[0]).includes(`provider.provisioning.available (seq=${notice.seq})`)),
      ).toBe(true);
    }, { timeout: 5_000 });

    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);

    const rendered = inspect(consoleCalls, { depth: Infinity, showHidden: true, getters: true });
    expect(rendered).not.toContain(CANARY);
    // The fixed reason code and the non-secret request id are what an operator gets.
    expect(rendered).toContain(reason);
    expect(rendered).toContain(REQUEST_ID);
    for (const file of filesUnder(storeDir)) {
      expect(readFileSync(file).includes(CANARY), file).toBe(false);
    }
    expect(await new CursorStore(storeDir).load(server.url, deviceId)).toBe(0);
  }, 15_000);
});
