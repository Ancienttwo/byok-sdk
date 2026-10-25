import { mkdtemp, mkdir, readFile, writeFile, stat, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createInMemoryByokCloud } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createDaemonWithAdapters, AgentHomeManager, type AgentMemoryExport } from '@byok-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady, waitForTaskCleanup } from '../../basic/goal-btw.test-support';
import { createByokServer } from '@byok-sdk/server';
import { HostExecutionCore, type ExecutionServer } from './core';
import { HostLedger } from './ledger';
import { HostMemoryPage, memoryRevision, type MemoryApproval } from './memory';
import { policy, template } from './test-support';

async function openMemoryHost(mode: 'cloud' | 'embedded') {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-e2e-'));
  const tenant = tenantId('product:memory-page');
  let agentRef = { agentId: 'main', profileRevision: '1' };
  const productId = 'memory-page';
  let core!: HostExecutionCore;
  const embedded = mode === 'embedded' ? createByokServer({ productId, longPollHoldMs: 30,
    wake: { consume: (wake, signal) => core.consume(wake, signal) } }) : undefined;
  const composition = embedded ? undefined : createInMemoryByokCloud({ instanceProductId: productId, longPollHoldMs: 30 });
  const cloud = composition?.cloud;
  await composition?.core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n, maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
  const http = serve({ fetch: request => Promise.resolve(embedded ? embedded.hono.fetch(request) : cloud!.fetch(request)), port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let ledger = new HostLedger(path.join(root, 'host.sqlite'), tenant);
  let deviceId = '';
  const options = {
    exportMemory: async (binding: { agentRef: typeof agentRef }): Promise<AgentMemoryExport> => daemon.exportAgentMemory!(binding.agentRef),
    isCurrent: (binding: { deviceId: string; agentRef: typeof agentRef }) => binding.deviceId === deviceId && JSON.stringify(binding.agentRef) === JSON.stringify(agentRef),
    notify: (device: string, notice: { intentId: string; agentRef: typeof agentRef }) => embedded
      ? embedded.enqueueAgentMemoryIntentNotice(device, notice) : cloud!.enqueueAgentMemoryIntentNotice(tenant, device, notice),
    authorizeProjection: (_device: string, mutation: { grantRef: string; policyRevision: string; writerEpoch: number }) => mutation.grantRef === 'memory-test-grant' && mutation.policyRevision === 'memory-test-policy' && mutation.writerEpoch === 1,
  };
  let page = new HostMemoryPage(ledger, options);
  const wakeServer = embedded ?? createByokServer({ productId, wake: { consume: (wake, signal) => core.consume(wake, signal) } });
  const executionServer: ExecutionServer = embedded ?? {
    executions: { submit: input => cloud!.submitAgentExecution(tenant, input) },
    tasks: { offer: id => cloud!.readTaskOffer(tenant, id), attempt: id => cloud!.readTaskAttempt(tenant, id),
      deviceTerminal: id => cloud!.readDeviceTerminal(tenant, id), cancel: async (id, reason) => { await cloud!.cancelTask(tenant, id, reason); } },
    wakes: wakeServer.wakes,
  };
  core = new HostExecutionCore(executionServer, ledger, { memory: page, reconcileMs: 100 });
  const adapter = new BotStubAdapter();
  const agentRoot = path.join(root, 'homes');
  const home = (await new AgentHomeManager({ hostStorageRoot: agentRoot }).layout.resolve(agentRef)).canonicalHome;
  await mkdir(path.join(home, 'notes'), { recursive: true });
  await writeFile(path.join(home, 'MEMORY.md'), 'original private-value\n');
  await writeFile(path.join(home, 'notes', 'x.md'), 'note to remove\n');
  const daemon = createDaemonWithAdapters({ productId, productName: 'Memory page', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'sdk'),
    agentHome: { hostStorageRoot: agentRoot }, agentEgress: { policy },
    agentMemoryExport: true,
    agentMemoryIntents: {
      fetch: request => page.transport(deviceId).fetch(request),
      complete: completion => page.transport(deviceId).complete(completion),
    },
    agentMemory: { capability: 'agent.memory.projection', grant: { grantRef: 'memory-test-grant', writerEpoch: 1, policyRevision: 'memory-test-policy' },
      redactor: { redact: snapshot => Buffer.from(JSON.stringify({ residentMemory: snapshot.files.find(file => file.path === 'MEMORY.md')?.content.replaceAll('private-value', '[redacted]') ?? null })) },
      port: { publish: input => page.projectionPort(deviceId).publish(input) },
    },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore(), longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
  const pairing = await (embedded ? embedded.pairing.createPairingCode({ productId }) : cloud!.createPairingCode(tenant, { productId }));
  deviceId = (await daemon.pair(pairing.code)).deviceId;
  await daemon.start(); await waitForReady(daemon);
  return {
    root, home, notify: options.notify, offer: executionServer.tasks.offer, adapter, deviceId, get agentRef() { return agentRef; }, daemon, get core() { return core; },
    setProfileRevision(revision: string) { agentRef = { ...agentRef, profileRevision: revision }; }, get page() { return page; }, get ledger() { return ledger; },
    async command(rest: Partial<MemoryApproval> = {}) {
      const row = await page.approve({ deviceId, agentRef, approvalRef: randomUUID(), path: 'MEMORY.md', operation: 'replace', content: 'replacement private-value\n', expiresAt: Date.now() + 60_000, ...rest });
      await page.flushNotices();
      await vi.waitFor(() => expect(page.intent(row.intent.intentId)?.readback).toBeDefined(), { timeout: 10_000 });
      return page.intent(row.intent.intentId)!;
    },
    async restartLedger() {
      await core.close(); ledger.close(); ledger = new HostLedger(path.join(root, 'host.sqlite'), tenant);
      page = new HostMemoryPage(ledger, options); core = new HostExecutionCore(executionServer, ledger, { memory: page, reconcileMs: 100 });
      await page.recoverRestores(); await core.recover();
    },
    input(key: string = randomUUID()) {
      const execution = template(deviceId);
      execution.payload.agentRef = { ...agentRef };
      return { key, source: 'user' as const, execution, waitUntil: Date.now() + 60_000 };
    },
    async project() {
      const input = this.input();
      const { taskId } = await core.enqueue(input);
      await vi.waitFor(() => expect(adapter.sessions.has(taskId)).toBe(true), { timeout: 10_000 });
      const session = adapter.sessions.get(taskId)!;
      session.finish({ text: 'done' });
      await vi.waitFor(async () => expect(await executionServer.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: { type: 'task.complete' } }), { timeout: 10_000 });
      await waitForTaskCleanup(daemon, session);
      await core.drain();
      return core.intent(input.key)!;
    },
    async close() {
      await core.close(); await daemon.stop(); await wakeServer.close(); ledger.close();
      await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections(); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== 'linux').each(['cloud', 'embedded'] as const)('memory page with real Linux %s mailbox, daemon, home lease and CAS', mode => {
  let host: Awaited<ReturnType<typeof openMemoryHost>>;
  beforeEach(async () => { host = await openMemoryHost(mode); });
  afterEach(async () => { await host?.close(); });

  it('replaces MEMORY.md, deletes a note, purges bodies, and survives Host restart', async () => {
    const original = await readFile(path.join(host.home, 'MEMORY.md'), 'utf8');
    const replaced = await host.command({ baseRevision: memoryRevision(original) });
    expect(replaced.readback).toMatchObject({ disposition: 'recorded', completion: { outcome: 'applied', result: { exists: true, revision: memoryRevision('replacement private-value\n') } } });
    expect(await readFile(path.join(host.home, 'MEMORY.md'), 'utf8')).toBe('replacement private-value\n');
    expect(replaced.intent).not.toHaveProperty('content');
    const deleted = await host.command({ path: 'notes/x.md', operation: 'delete', content: undefined, baseRevision: memoryRevision('note to remove\n') });
    expect(deleted.readback!.completion.outcome).toBe('applied');
    await expect(stat(path.join(host.home, 'notes', 'x.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await host.restartLedger();
    expect(host.page.intent(replaced.intent.intentId)!.readback).toEqual(replaced.readback);
    expect(host.page.intent(deleted.intent.intentId)!.readback).toEqual(deleted.readback);
    const beforeRepeat = await readFile(path.join(host.home, 'MEMORY.md'), 'utf8');
    const notice = { intentId: replaced.intent.intentId, agentRef: host.agentRef };
    const repeated = await host.notify(host.deviceId, notice);
    expect(await host.notify(host.deviceId, notice)).toEqual(repeated);
    expect(await readFile(path.join(host.home, 'MEMORY.md'), 'utf8')).toBe(beforeRepeat);
    // This verifies stable mailbox identity/sequence and retained content. The
    // ack count below checks retained ledger state, not processing of a new notice.
    const deviceLedger = path.join(host.home, '.byok', 'agent-memory-intents-v1.json');
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(deviceLedger, 'utf8'));
      expect(state.records.filter((row: { ackedAt?: string }) => row.ackedAt)).toHaveLength(2);
    });
  });

  it('ends the EMPTY-base write at conflict and requires a new explicit approval to replace', async () => {
    const before = await readFile(path.join(host.home, 'MEMORY.md'), 'utf8');
    const probe = await host.command();
    expect(probe.readback!.completion).toMatchObject({ outcome: 'conflict', observed: { exists: true, revision: memoryRevision(before) } });
    expect(await readFile(path.join(host.home, 'MEMORY.md'), 'utf8')).toBe(before);
    expect(Object.keys(host.ledger.snapshot().memory!.intents)).toHaveLength(1);
    const result = await host.command({ baseRevision: memoryRevision(before), content: 'explicit new replacement' });
    expect(result.intent.intentId).not.toBe(probe.intent.intentId);
    expect(result.readback!.completion.outcome).toBe('applied');
    const forbidden = await host.command({ operation: 'delete', content: undefined, baseRevision: memoryRevision('explicit new replacement') });
    expect(forbidden.readback!.completion).toMatchObject({ outcome: 'rejected', code: 'memory_md_not_deletable' });
  });

  it('projects only redacted resident text after task close and blocks oversized text after replace', async () => {
    await host.project();
    const binding = { deviceId: host.deviceId, agentRef: host.agentRef };
    const first = host.page.contextPack(binding);
    expect(first.residentMemory!.text).toBe('original [redacted]\n');
    expect(JSON.stringify(first)).not.toContain('private-value');
    const replacement = 'é'.repeat(4096) + 'x';
    const row = await host.command({ baseRevision: memoryRevision('original private-value\n'), content: replacement });
    expect(row.readback!.completion.outcome).toBe('applied');
    expect(host.page.contextPack(binding)).toEqual(first); // Intent results do not forge a fresh projection.
    await host.project();
    expect(() => host.page.contextPack(binding)).toThrow('exceeds 8 KiB');
  });
});


describe.skipIf(process.platform !== 'linux').each(['cloud', 'embedded'] as const)('memory bootstrap and refresh through the %s core', mode => {
  let host: Awaited<ReturnType<typeof openMemoryHost>>;
  beforeEach(async () => { host = await openMemoryHost(mode); });
  afterEach(async () => { await host?.close(); });

  it('starts a new Agent through the core and receives its first task-close projection', async () => {
    expect(host.ledger.snapshot().memory?.projections ?? {}).toEqual({});
    const intent = await host.project();
    expect(intent).toMatchObject({ conclusion: 'succeeded', attempts: 1 });
    const offer = await host.offer(intent.taskId);
    expect(offer?.payload).toHaveProperty('instruction', template(host.deviceId).payload.instruction);
    expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef }).residentMemory?.text).toBe('original [redacted]\n');
  });

  it('runs with no MEMORY.md and after a profile revision bump', async () => {
    await unlink(path.join(host.home, 'MEMORY.md'));
    expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef })).toEqual({});
    expect((await host.project()).conclusion).toBe('succeeded');
    expect(await readFile(path.join(host.home, 'MEMORY.md'), 'utf8')).toBe(''); // The SDK initializes the missing file.
    host.setProfileRevision('2');
    expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef })).toEqual({});
    expect((await host.project()).conclusion).toBe('succeeded');
    expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef }).residentMemory?.text).toBe('');
  });

  it('refreshes an oversized projection after a verified small replace, including Host restart', async () => {
    const oversized = 'x'.repeat(8193);
    await writeFile(path.join(host.home, 'MEMORY.md'), oversized);
    await host.project(); // Bootstrap is allowed; its real task-close projection discovers the size.
    const input = host.input('blocked-until-user-fix');
    const blocked = await host.core.enqueue(input);
    expect(blocked).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    await host.restartLedger();
    expect(host.core.intent(input.key)).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    const result = await host.command({ baseRevision: memoryRevision(oversized), content: 'small private-value\n' });
    expect(result.readback?.completion.outcome).toBe('applied');
    expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef })).toEqual({});
    await vi.waitFor(() => expect(host.adapter.sessions.has(blocked.taskId)).toBe(true), { timeout: 10_000 });
    const offer = await host.offer(blocked.taskId);
    expect(offer?.payload).toHaveProperty('instruction', input.execution.payload.instruction);
    const session = host.adapter.sessions.get(blocked.taskId)!;
    session.finish({ text: 'refreshed' });
    await waitForTaskCleanup(host.daemon, session);
    await host.core.drain();
    await vi.waitFor(() => expect(host.page.contextPack({ deviceId: host.deviceId, agentRef: host.agentRef }).residentMemory?.text).toBe('small [redacted]\n'));
    expect(host.core.intent(input.key)).toMatchObject({ conclusion: 'succeeded', attempts: 1 });
  });
});

if (process.env.BYOK_REQUIRE_MEMORY_RESTORE_LINUX === '1' && process.platform !== 'linux') throw new Error('Linux restore qualification requires native Linux');
describe.skipIf(process.platform !== 'linux')('tree restore with real Linux embedded notification and export', () => {
  let host: Awaited<ReturnType<typeof openMemoryHost>>;
  beforeEach(async () => { host = await openMemoryHost('embedded'); });
  afterEach(async () => { await host?.close(); });
  function files() {
    return Object.entries({ 'MEMORY.md': 'restored root', 'notes/a.md': 'A', 'notes/b.md': 'B' }).map(([path, content]) => ({ path, content, revision: memoryRevision(content), byteCount: Buffer.byteLength(content) }));
  }
  it('restores an empty tree and excludes queued executions until every terminal, including duplicate notices', async () => {
    await writeFile(path.join(host.home, 'MEMORY.md'), ''); await unlink(path.join(host.home, 'notes/x.md'));
    const binding = { deviceId: host.deviceId, agentRef: host.agentRef };
    const restore = await host.page.restore({ ...binding, restoreId: 'linux-initial', files: files(), mode: 'initial', expiresAt: Date.now() + 60_000 });
    const queued = await host.core.enqueue(host.input('during-restore'));
    expect(queued.phase).toBe('memory_blocked'); expect(await host.offer(queued.taskId)).toBeUndefined();
    // Send exactly one file, then reopen the Host ledger before delivering the remaining files.
    const first = restore.files[0]!;
    await host.notify(host.deviceId, { intentId: first.intentId!, agentRef: host.agentRef });
    await vi.waitFor(() => expect(host.page.intent(first.intentId!)?.readback?.completion.outcome).toBe('applied'), { timeout: 10_000 });
    expect(await host.offer(queued.taskId)).toBeUndefined();
    await host.restartLedger();
    expect(host.page.restoreResult(binding, 'linux-initial')!.status).toBe('applying');
    await host.page.flushNotices();
    await vi.waitFor(() => expect(host.page.restoreResult(binding, 'linux-initial')!.status).toBe('applied'), { timeout: 10_000 });
    await host.core.drain();
    await vi.waitFor(() => expect(host.adapter.sessions.has(queued.taskId)).toBe(true), { timeout: 10_000 });
    const session = host.adapter.sessions.get(queued.taskId)!; session.finish({ text: 'done' });
    await waitForTaskCleanup(host.daemon, session);
    const exported = await host.daemon.exportAgentMemory!(host.agentRef);
    expect(exported.files).toEqual(files());
    await host.notify(host.deviceId, { intentId: first.intentId!, agentRef: host.agentRef });
    await vi.waitFor(async () => expect((await host.daemon.exportAgentMemory!(host.agentRef)).snapshotDigest).toBe(exported.snapshotDigest), { timeout: 10_000 });
  });
  it('initial rejects a nonempty home without writes; approved overwrite deletes extra notes and matches the target export', async () => {
    const binding = { deviceId: host.deviceId, agentRef: host.agentRef };
    const original = await host.daemon.exportAgentMemory!(host.agentRef);
    const rejected = await host.page.restore({ ...binding, restoreId: 'initial-nonempty', files: files(), mode: 'initial', expiresAt: Date.now() + 60_000 });
    expect(rejected.status).toBe('conflict'); expect(host.ledger.snapshot().memory!.intents).toEqual({});
    expect((await host.daemon.exportAgentMemory!(host.agentRef)).snapshotDigest).toBe(original.snapshotDigest);
    await host.page.restore({ ...binding, restoreId: 'approved-overwrite', files: files(), mode: 'overwrite', observed: original, expiresAt: Date.now() + 60_000 });
    await host.page.flushNotices();
    await vi.waitFor(() => expect(host.page.restoreResult(binding, 'approved-overwrite')!.status).toBe('applied'), { timeout: 10_000 });
    // Host readback precedes the device's final lease release; retry only the read.
    await vi.waitFor(async () => expect((await host.daemon.exportAgentMemory!(host.agentRef)).files).toEqual(files()), { timeout: 10_000 });
    await expect(stat(path.join(host.home, 'notes/x.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
