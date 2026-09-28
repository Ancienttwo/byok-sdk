import { promises as fs, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_PROVISIONING_CAPABILITY,
  createEnvelope,
  type ProviderProvisioningCompletion,
  type ProviderProvisioningReadback,
} from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import {
  ProviderProvisioningNoticeError,
  createProviderProvisioningNoticeProcessor,
  type ProviderProvisioningHandler,
  type ProviderProvisioningNotice,
} from '../daemon/provider-provisioning';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const TENANT = 'tenant-provisioning';
const DEVICE = 'device-provisioning';
const REQUEST_A = '30000000-0000-4000-8000-000000000001';
const REQUEST_B = '30000000-0000-4000-8000-000000000002';
const REQUEST_C = '30000000-0000-4000-8000-000000000003';
const REQUEST_D = '30000000-0000-4000-8000-000000000004';
const DIGEST = `sha256:${'d'.repeat(64)}`;
/** Stands in for sealed ciphertext; it must never reach any daemon-owned byte. */
const CIPHERTEXT_CANARY = 'CANARY-SEALED-CIPHERTEXT-7f3a9c';

type ReadbackKind = 'applied' | 'rejected' | 'expired' | 'rotated' | 'conflict' | 'idempotent';

function completionFor(requestId: string, kind: ReadbackKind): ProviderProvisioningCompletion {
  const identity = { requestId, operation: 'configure', operationGeneration: '2', operationDigest: DIGEST } as const;
  if (kind === 'applied' || kind === 'conflict' || kind === 'idempotent') {
    return {
      outcome: 'applied',
      ...identity,
      providerStatus: {
        profileRef: 'host-agent-1',
        providerKind: 'zai',
        modelId: 'glm-5.3-flash',
        capabilities: [],
        secretConfigured: true,
      },
      binding: {
        profileRef: 'host-agent-1',
        profileRevision: '1759000000000',
        profileHash: `sha256:${'a'.repeat(64)}`,
        modelId: 'glm-5.3-flash',
        requiredCapabilities: [],
      },
      keyCheck: { result: 'ok' },
    };
  }
  const code = kind === 'expired' ? 'request_expired' : kind === 'rotated' ? 'sealing_key_rotated' : 'seal_open_failed';
  return { outcome: 'rejected', ...identity, code };
}

function readbackFor(
  identity: { tenantId: string; deviceId: string },
  requestId: string,
  kind: ReadbackKind,
): ProviderProvisioningReadback {
  const disposition =
    kind === 'expired' || kind === 'rotated'
      ? 'host_terminal'
      : kind === 'conflict'
        ? 'conflict'
        : kind === 'idempotent'
          ? 'idempotent'
          : 'recorded';
  return {
    tenantId: identity.tenantId,
    deviceId: identity.deviceId,
    requestId,
    disposition,
    completion: completionFor(requestId, kind),
    completedAt: '2026-09-28T05:00:00.000Z',
  };
}

describe('provider provisioning notice processor', () => {
  const identity = { tenantId: TENANT, deviceId: DEVICE };

  it('fails closed when no handler is configured', async () => {
    const process = createProviderProvisioningNoticeProcessor({ ...identity, handler: undefined });
    await expect(process({ requestId: REQUEST_A })).rejects.toMatchObject({ reason: 'handler_unconfigured' });
  });

  it('hands the host exactly a frozen { requestId }', async () => {
    const seen: ProviderProvisioningNotice[] = [];
    const payload = { requestId: REQUEST_A };
    const process = createProviderProvisioningNoticeProcessor({
      ...identity,
      handler: async (notice) => {
        seen.push(notice);
        return readbackFor(identity, notice.requestId, 'applied');
      },
    });
    await process(payload);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!)).toEqual(['requestId']);
    expect(seen[0]).toEqual({ requestId: REQUEST_A });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).not.toBe(payload);
  });

  it.each(['applied', 'rejected', 'expired', 'rotated', 'conflict', 'idempotent'] as const)(
    'accepts a %s terminal readback',
    async (kind) => {
      const process = createProviderProvisioningNoticeProcessor({
        ...identity,
        handler: async ({ requestId }) => readbackFor(identity, requestId, kind),
      });
      await expect(process({ requestId: REQUEST_A })).resolves.toMatchObject({ requestId: REQUEST_A });
    },
  );

  it.each([
    ['another tenant', { ...readbackFor(identity, REQUEST_A, 'applied'), tenantId: 'tenant-other' }],
    ['another device', { ...readbackFor(identity, REQUEST_A, 'applied'), deviceId: 'device-other' }],
    ['another request', readbackFor(identity, REQUEST_B, 'applied')],
    ['a pending state', { ...readbackFor(identity, REQUEST_A, 'applied'), disposition: 'pending' }],
    ['a secret field', { ...readbackFor(identity, REQUEST_A, 'applied'), secret: 'sk-canary' }],
    ['nothing', undefined],
  ])('refuses a readback for %s', async (_label, raw) => {
    const process = createProviderProvisioningNoticeProcessor({
      ...identity,
      handler: (async () => raw) as unknown as ProviderProvisioningHandler,
    });
    await expect(process({ requestId: REQUEST_A })).rejects.toBeInstanceOf(ProviderProvisioningNoticeError);
  });

  it('turns a handler failure into a closed error without its message or cause, so the row stays un-acknowledged', async () => {
    const process = createProviderProvisioningNoticeProcessor({
      ...identity,
      handler: async () => {
        throw new Error('host fetch transport failed');
      },
    });
    const error = await process({ requestId: REQUEST_A }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderProvisioningNoticeError);
    expect((error as ProviderProvisioningNoticeError).reason).toBe('handler_failed');
    expect((error as ProviderProvisioningNoticeError).requestId).toBe(REQUEST_A);
    expect((error as Error).message).not.toContain('host fetch transport failed');
    expect((error as Error).cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Daemon seam, end to end over the real long-poll transport.
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

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

type Identity = { tenantId: string; deviceId: string };

/** `handler` is built from the paired identity, so its readbacks can name this exact tenant and device. */
async function startDaemon(options: {
  handler?: (identity: Identity) => ProviderProvisioningHandler;
  journal?: boolean;
} = {}) {
  const server = await TestServer.start();
  servers.push(server);
  const storeDir = await tmpDir('byok-provisioning-store-');
  const workspaceRoot = await tmpDir('byok-provisioning-workspace-');
  let bound: ProviderProvisioningHandler | undefined;
  const build = options.handler;
  const handler: ProviderProvisioningHandler | undefined =
    build === undefined
      ? undefined
      : async (notice) => {
          if (bound === undefined) throw new Error('test identity not ready');
          return bound(notice);
        };
  const adapter = new StubRuntimeAdapter();
  const daemon = createDaemonWithAdapters(
    {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test',
      productId: 'test-product',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      ...(handler === undefined ? {} : { providerProvisioning: handler }),
      ...(options.journal === true ? { hostedJournal: { mode: 'sqlite' as const } } : {}),
    },
    [adapter],
    { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
  );
  daemons.push(daemon);
  // `pair()` discloses only the device id; the Host knows its tenant from its
  // own configuration, exactly as a real provisioning handler would.
  server.setPairingTenantId('pairing-code', TENANT);
  const record = await daemon.pair('pairing-code');
  const identity: Identity = { tenantId: TENANT, deviceId: record.deviceId };
  if (build !== undefined) bound = build(identity);
  await daemon.start();
  const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello', 5_000);
  if (hello.type !== 'conn.hello') throw new Error('unreachable');
  const cursor = () => new CursorStore(storeDir).load(server.url, record.deviceId);
  return { server, daemon, record, identity, storeDir, adapter, hello, cursor };
}

function notice(server: TestServer, requestId: string) {
  return createEnvelope('provider.provisioning.available', { requestId }, { seq: server.nextSeq() });
}

/** Resolves once the connection manager has logged a handler failure for this notice seq. */
function handlerFailureLogged(errorSpy: { mock: { calls: unknown[][] } }, seq: number): () => void {
  return () => {
    const logged = errorSpy.mock.calls.some(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes(`provider.provisioning.available (seq=${seq})`),
    );
    expect(logged).toBe(true);
  };
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe('createDaemon providerProvisioning seam', () => {
  it('advertises provider-provisioning.v1 only when a handler is configured', async () => {
    const configured = await startDaemon({
      handler: (identity: Identity) => async ({ requestId }: ProviderProvisioningNotice) =>
        readbackFor(identity, requestId, 'applied'),
    });
    if (configured.hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(configured.hello.payload.capabilities).toContain(PROVIDER_PROVISIONING_CAPABILITY);

    const bare = await startDaemon();
    if (bare.hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(bare.hello.payload.capabilities).not.toContain(PROVIDER_PROVISIONING_CAPABILITY);
  });

  it('rejects a non-function providerProvisioning at construction', () => {
    expect(() =>
      createDaemonWithAdapters(
        {
          localAgentRelease: { version: '0.0.0-test' },
          productName: 'Test',
          productId: 'test-product',
          serverUrl: 'http://127.0.0.1:1',
          workspaceRoot: os.tmpdir(),
          storeDir: path.join(os.tmpdir(), 'byok-provisioning-never-created'),
          providerProvisioning: { handle: () => undefined } as unknown as ProviderProvisioningHandler,
        },
        [new StubRuntimeAdapter()],
      ),
    ).toThrow(/providerProvisioning must be a handler function/u);
  });

  it('fails closed without a handler: the notice is not acknowledged and no runtime starts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, cursor, adapter } = await startDaemon();
    const envelope = notice(server, REQUEST_A);
    server.pushLongPollEvent(envelope);
    await vi.waitFor(handlerFailureLogged(errorSpy, envelope.seq), { timeout: 5_000 });
    const failure = errorSpy.mock.calls.find((args) => String(args[0]).includes('provider.provisioning.available'));
    expect(failure?.[1]).toBeInstanceOf(ProviderProvisioningNoticeError);
    expect(await cursor()).toBe(0);
    expect(adapter.sessions).toHaveLength(0);
  });

  it('keeps the cursor behind a transport failure and advances only after a durable readback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    let failNext = true;
    const { server, cursor } = await startDaemon({
      handler: (identity: Identity) => async ({ requestId }: ProviderProvisioningNotice) => {
        calls.push(requestId);
        if (failNext) {
          failNext = false;
          throw new Error('host fetch transport failed');
        }
        return readbackFor(identity, requestId, 'applied');
      },
    });
    const envelope = notice(server, REQUEST_A);
    server.pushLongPollEvent(envelope);
    await vi.waitFor(handlerFailureLogged(errorSpy, envelope.seq), { timeout: 5_000 });
    expect(await cursor()).toBe(0);

    // The mailbox retained the row; redeliver it (TestServer scripts redelivery explicitly).
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => {
      expect(await cursor()).toBe(envelope.seq);
    }, { timeout: 5_000 });
    expect(calls).toEqual([REQUEST_A, REQUEST_A]);
  });

  it('does not acknowledge a readback that fails validation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, cursor } = await startDaemon({
      handler: (identity: Identity) => async () =>
        // A readback for a different request is not this notice's durable fact.
        readbackFor(identity, REQUEST_D, 'applied'),
    });
    const envelope = notice(server, REQUEST_A);
    server.pushLongPollEvent(envelope);
    await vi.waitFor(handlerFailureLogged(errorSpy, envelope.seq), { timeout: 5_000 });
    expect(await cursor()).toBe(0);
  });

  it('consumes deterministic terminal readbacks (expired, rotated, rejected, conflict) and advances the cursor', async () => {
    const kinds = new Map<string, ReadbackKind>([
      [REQUEST_A, 'expired'],
      [REQUEST_B, 'rotated'],
      [REQUEST_C, 'rejected'],
      [REQUEST_D, 'conflict'],
    ]);
    const { server, cursor } = await startDaemon({
      handler: (identity: Identity) => async ({ requestId }: ProviderProvisioningNotice) =>
        readbackFor(identity, requestId, kinds.get(requestId)!),
    });
    let lastSeq = 0;
    for (const requestId of kinds.keys()) {
      const envelope = notice(server, requestId);
      lastSeq = envelope.seq;
      server.pushLongPollEvent(envelope);
    }
    await vi.waitFor(async () => {
      expect(await cursor()).toBe(lastSeq);
    }, { timeout: 5_000 });
  });

  it.skipIf(!isSqliteAvailable())(
    'never journals the notice, and a ciphertext-carrying notice never reaches the handler or disk',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const seen: ProviderProvisioningNotice[] = [];
      const { server, cursor, storeDir, daemon } = await startDaemon({
        journal: true,
        handler: (identity: Identity) => async (notice: ProviderProvisioningNotice) => {
          seen.push(notice);
          return readbackFor(identity, notice.requestId, 'applied');
        },
      });

      const valid = notice(server, REQUEST_A);
      server.pushLongPollEvent(valid);
      await vi.waitFor(async () => {
        expect(await cursor()).toBe(valid.seq);
      }, { timeout: 5_000 });
      expect(seen).toEqual([{ requestId: REQUEST_A }]);

      // A sender that inlines ciphertext is refused at the wire: the strict
      // payload fails validation, the handler never runs and the cursor freezes.
      const poisonedSeq = server.nextSeq();
      server.pushRawLongPollEvent({
        v: 1,
        id: '30000000-0000-4000-8000-0000000000ff',
        ts: '2026-09-28T05:00:00.000Z',
        type: 'provider.provisioning.available',
        seq: poisonedSeq,
        payload: { requestId: REQUEST_B, sealed: { enc: CIPHERTEXT_CANARY, ct: CIPHERTEXT_CANARY } },
      });
      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes(`seq=${poisonedSeq}`))).toBe(true);
      }, { timeout: 5_000 });
      expect(seen).toEqual([{ requestId: REQUEST_A }]);
      expect(await cursor()).toBe(valid.seq);

      await daemon.stop();
      daemons.splice(daemons.indexOf(daemon), 1);

      const db = new DatabaseSync(path.join(storeDir, 'daemon.db'), { readOnly: true });
      try {
        const rows = db.prepare('SELECT bytes FROM journal_envelope').all() as Array<{ bytes: string }>;
        for (const row of rows) {
          expect(row.bytes).not.toContain('provider.provisioning.available');
          expect(row.bytes).not.toContain(REQUEST_A);
        }
      } finally {
        db.close();
      }
      for (const file of filesUnder(storeDir)) {
        const bytes = readFileSync(file);
        expect(bytes.includes(CIPHERTEXT_CANARY), file).toBe(false);
        expect(bytes.includes('provider.provisioning.available'), file).toBe(false);
      }
    },
    15_000,
  );
});

describe('no local listener for provisioning', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientSrc = path.resolve(here, '..');
  const keysSrc = path.resolve(here, '../../../keys/src');
  const LISTENER = /\bcreateServer\s*\(|\.listen\s*\(/u;

  function productionSources(root: string): string[] {
    return filesUnder(root).filter(
      (file) => file.endsWith('.ts') && !file.includes(`${path.sep}__tests__${path.sep}`) && !file.endsWith('.test.ts'),
    );
  }

  it('adds no createServer/listen in client or keys beyond the existing local control and ownership sockets', () => {
    const offenders = [...productionSources(clientSrc), ...productionSources(keysSrc)]
      .filter((file) => LISTENER.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(path.resolve(here, '../../..'), file).split(path.sep).join('/'))
      .sort();
    expect(offenders).toEqual([
      'client/src/daemon/control-server.ts',
      'client/src/daemon/daemon-owner.ts',
      'client/src/daemon/path-mutation-gate.ts',
    ]);
  });

  it('keeps the provisioning seam itself free of any listener or byok route', () => {
    const source = readFileSync(path.join(clientSrc, 'daemon', 'provider-provisioning.ts'), 'utf8');
    expect(LISTENER.test(source)).toBe(false);
    expect(source).not.toMatch(/\bfetch\s*\(|authedFetch|\/byok\//u);
  });
});
