import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createInMemoryByokCloud } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createDaemonWithAdapters, AgentHomeManager } from '@byok-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady, waitForTaskCleanup } from '../../basic/goal-btw.test-support';
import { HostLedger } from './ledger';
import { HostMemoryPage, memoryRevision, type MemoryApproval } from './memory';
import { policy, template } from './test-support';

async function openMemoryHost() {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-e2e-'));
  const tenant = tenantId('product:memory-page');
  const agentRef = { agentId: 'main', profileRevision: '1' };
  const productId = 'memory-page';
  const composition = createInMemoryByokCloud({ instanceProductId: productId, longPollHoldMs: 30 });
  const cloud = composition.cloud;
  await composition.core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n, maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
  const http = serve({ fetch: request => Promise.resolve(cloud.fetch(request)), port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let ledger = new HostLedger(path.join(root, 'host.sqlite'), tenant);
  let deviceId = '';
  const options = {
    isCurrent: (binding: { deviceId: string; agentRef: typeof agentRef }) => binding.deviceId === deviceId && JSON.stringify(binding.agentRef) === JSON.stringify(agentRef),
    notify: (device: string, notice: { intentId: string; agentRef: typeof agentRef }) => cloud.enqueueAgentMemoryIntentNotice(tenant, device, notice),
    authorizeProjection: (_device: string, mutation: { grantRef: string; policyRevision: string; writerEpoch: number }) => mutation.grantRef === 'memory-test-grant' && mutation.policyRevision === 'memory-test-policy' && mutation.writerEpoch === 1,
  };
  let page = new HostMemoryPage(ledger, options);
  const adapter = new BotStubAdapter();
  const agentRoot = path.join(root, 'homes');
  const home = (await new AgentHomeManager({ hostStorageRoot: agentRoot }).layout.resolve(agentRef)).canonicalHome;
  await mkdir(path.join(home, 'notes'), { recursive: true });
  await writeFile(path.join(home, 'MEMORY.md'), 'original private-value\n');
  await writeFile(path.join(home, 'notes', 'x.md'), 'note to remove\n');
  const daemon = createDaemonWithAdapters({ productId, productName: 'Memory page', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: `http://127.0.0.1:${address.port}`, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'sdk'),
    agentHome: { hostStorageRoot: agentRoot }, agentEgress: { policy }, hostedJournal: { mode: 'sqlite' },
    agentMemoryIntents: {
      fetch: request => page.transport(deviceId).fetch(request),
      complete: completion => page.transport(deviceId).complete(completion),
    },
    agentMemory: { capability: 'agent.memory.projection', grant: { grantRef: 'memory-test-grant', writerEpoch: 1, policyRevision: 'memory-test-policy' },
      redactor: { redact: snapshot => Buffer.from(JSON.stringify({ residentMemory: snapshot.files.find(file => file.path === 'MEMORY.md')?.content.replaceAll('private-value', '[redacted]') ?? null })) },
      port: { publish: input => page.projectionPort(deviceId).publish(input) },
    },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore(), longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
  const pairing = await cloud.createPairingCode(tenant, { productId });
  deviceId = (await daemon.pair(pairing.code)).deviceId;
  await daemon.start(); await waitForReady(daemon);
  return {
    root, home, cloud, composition, adapter, deviceId, agentRef, daemon, get page() { return page; }, get ledger() { return ledger; },
    async command(rest: Partial<MemoryApproval> = {}) {
      const row = await page.approve({ deviceId, agentRef, approvalRef: randomUUID(), path: 'MEMORY.md', operation: 'replace', content: 'replacement private-value\n', expiresAt: Date.now() + 60_000, ...rest });
      await page.flushNotices();
      await vi.waitFor(() => expect(page.intent(row.intent.intentId)?.readback).toBeDefined(), { timeout: 10_000 });
      return page.intent(row.intent.intentId)!;
    },
    restartLedger() { ledger.close(); ledger = new HostLedger(path.join(root, 'host.sqlite'), tenant); page = new HostMemoryPage(ledger, options); },
    async project() {
      const taskId = randomUUID();
      await cloud.submitAgentExecution(tenant, { taskId, ...template(deviceId) });
      await vi.waitFor(() => expect(adapter.sessions.has(taskId)).toBe(true), { timeout: 10_000 });
      const session = adapter.sessions.get(taskId)!;
      session.finish({ text: 'done' });
      await vi.waitFor(async () => expect(await cloud.readDeviceTerminal(tenant, taskId)).toMatchObject({ envelope: { type: 'task.complete' } }), { timeout: 10_000 });
      await waitForTaskCleanup(daemon, session);
    },
    async close() {
      await daemon.stop(); ledger.close();
      await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in http) http.closeAllConnections(); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== 'linux')('memory page with real Linux mailbox, daemon, home lease and CAS', () => {
  let host: Awaited<ReturnType<typeof openMemoryHost>>;
  beforeEach(async () => { host = await openMemoryHost(); });
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
    host.restartLedger();
    expect(host.page.intent(replaced.intent.intentId)!.readback).toEqual(replaced.readback);
    expect(host.page.intent(deleted.intent.intentId)!.readback).toEqual(deleted.readback);
    await host.cloud.enqueueAgentMemoryIntentNotice(tenantId('product:memory-page'), host.deviceId, { intentId: replaced.intent.intentId, agentRef: host.agentRef });
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
    expect(first.residentMemory.text).toBe('original [redacted]\n');
    expect(JSON.stringify(first)).not.toContain('private-value');
    const replacement = 'é'.repeat(4096) + 'x';
    const row = await host.command({ baseRevision: memoryRevision('original private-value\n'), content: replacement });
    expect(row.readback!.completion.outcome).toBe('applied');
    expect(host.page.contextPack(binding)).toEqual(first); // Intent results do not forge a fresh projection.
    await host.project();
    expect(() => host.page.contextPack(binding)).toThrow('exceeds 8 KiB');
  });
});
