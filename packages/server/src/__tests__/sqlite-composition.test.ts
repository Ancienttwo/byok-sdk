import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createByokServer } from '..';
import { isSqliteAvailable } from '../sqlite-support';
import { serverTenantId } from '../stores';
import { createSqliteEmbeddedStores } from '../stores/sqlite';
import { submitFrozen, type FrozenInput } from '../execution-core';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'rev-1' } as const;

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;

describeSqlite('createByokServer SQLite composition', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('selects SQLite explicitly and closes it idempotently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-server-sqlite-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const productId = 'sqlite-composition-test';
    const seeded = createSqliteEmbeddedStores(
      { path },
      { clock: createMutableClock(), crypto: createWebCrypto() },
    );
    await seeded.cloud.tasks.reserveAgentOffer(serverTenantId(productId), {
      taskId: 'task-before-restart',
      deviceId: 'device-1',
      agentRef: AGENT_REF,
    });
    await seeded.close();

    const server = createByokServer({
      productId,
      storage: { kind: 'sqlite', path },
    });

    await expect(server.tasks.get('task-before-restart')).resolves.toMatchObject({
      taskId: 'task-before-restart',
      state: 'Offered',
    });
    await Promise.all([server.close(), server.close()]);
    await expect(server.tasks.list()).rejects.toThrow('SQLite embedded composition is closed');
  });

  it('keeps memory as the zero-configuration default', async () => {
    const server = createByokServer({ productId: 'memory-composition-test' });
    await expect(server.tasks.list()).resolves.toEqual({ tasks: [] });
    await server.close();
  });

  it.each([
    ['agent-memory-commit-on-success', { agentMemoryCommit: 'on-success-if-advertised' as const }],
    ['native-sessions', { nativeSessions: { fromMs: 1, toMs: 2, ifAdvertised: true as const } }],
  ] as const)('replays frozen %s admission after SQLite restart and capability change', async (capability, conditional) => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-frozen-retry-')); directories.push(directory);
    const path = join(directory, 'server.sqlite'), productId = 'conditional-retry', tenant = serverTenantId(productId);
    const deviceId = 'device-1';
    const capabilities = ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack',
      'agent-egress-fresh-session', 'terminal-projection-selection', 'agent-memory-selection'];
    const openStores = () => createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
    const seed = openStores();
    await seed.cloud.devices.register(tenant, { deviceId, productId, deviceName: 'fixture', devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
    await seed.cloud.devices.recordCapabilities(tenant, { deviceId, capabilities });
    await seed.close();
    const fault = new DatabaseSync(path);
    fault.exec("CREATE TRIGGER fail_append BEFORE INSERT ON mailbox_message BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;"); fault.close();
    const input: FrozenInput = { taskId: 'conditional-retry', deviceId, payload: { instruction: 'dream', runtime: 'pi',
      agentRef: { agentId: 'main', profileRevision: '1' }, session: { mode: 'fresh' }, agentMemory: 'none', terminalProjection: { mode: 'none' },
      egressPolicy: { policyRevision: 'test', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } }, ...conditional } };
    let server = createByokServer({ productId, storage: { kind: 'sqlite', path } });
    const submit = () => submitFrozen({ offer: server.tasks.offer, submit: server.executions.submit }, input, () => true);
    try {
      await expect(submit()).rejects.toMatchObject({ code: 'task_offer_append_refused' });
      const recorded = await server.tasks.offer(input.taskId!);
      expect(recorded).toMatchObject({ delivered: false });
      await server.close();
      const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER fail_append'); repair.close();
      const reopened = openStores();
      await reopened.cloud.devices.recordCapabilities(tenant, { deviceId, capabilities: [...capabilities, capability] });
      await reopened.close();
      server = createByokServer({ productId, storage: { kind: 'sqlite', path } });
      await expect(submit()).resolves.toBe('delivered');
      expect(await server.tasks.offer(input.taskId!)).toMatchObject({ delivered: true, payload: recorded!.payload });
    } finally { await server.close(); }
  });
});
