import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import { createEnvelope, type AgentMemoryIntentV1, type AgentMemoryIntentCompletion } from '@byok-sdk/protocol';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const control = vi.hoisted(() => ({
  mode: undefined as 'applying' | 'terminal' | 'acked' | 'delete' | undefined,
  cas: 0,
  fired: false,
  last: undefined as ChildProcessWithoutNullStreams | undefined,
}));

// Every process is the verified SDK release helper. The harness only kills a
// real process at a protocol boundary. It never supplies a replacement binary,
// success response, filesystem implementation or proof flag.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (!String(args[0]).includes('darwin-') || !child.stdin || !child.stdout) return child;
    const helper = child as ChildProcessWithoutNullStreams;
    control.last = helper;
    let deleteId: string | undefined;
    let output = '';
    const write = helper.stdin.write;
    helper.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      const request = JSON.parse(String(chunk));
      if ((request.op === 'replace' || request.op === 'delete') && !request.path.startsWith('.byok/')) control.cas++;
      if (request.op === 'delete' && control.mode === 'delete') deleteId = request.id;
      if (request.op === 'replace' && request.path === '.byok/agent-memory-intents-v1.json') {
        const row = JSON.parse(Buffer.from(request.contentBase64, 'base64').toString('utf8')).records[0];
        const stage = row.ackedAt !== null ? 'acked' : row.state === 'applying' ? 'applying' : 'terminal';
        if (control.mode === stage) {
          control.mode = undefined;
          control.fired = true;
          helper.kill('SIGKILL');
          return true;
        }
      }
      return Reflect.apply(write, helper.stdin, [chunk, ...rest]);
    }) as typeof helper.stdin.write;
    const emit = helper.stdout.emit;
    helper.stdout.emit = ((event: string | symbol, ...values: unknown[]) => {
      if (event !== 'data') return Reflect.apply(emit, helper.stdout, [event, ...values]);
      output += String(values[0]);
      for (;;) {
        const end = output.indexOf('\n');
        if (end < 0) break;
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        const response = JSON.parse(line);
        if (response.id === deleteId) {
          expect(response.ok).toBe(true);
          control.mode = undefined;
          control.fired = true;
          helper.kill('SIGKILL');
          deleteId = undefined;
        } else Reflect.apply(emit, helper.stdout, ['data', Buffer.from(`${line}\n`)]);
      }
      return true;
    }) as typeof helper.stdout.emit;
    return helper;
  } };
});

import { hasAgentMemoryHelperBuild } from './fixtures/agent-memory-helper-build';
import { AgentHomeManager } from '../agent-home';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { resolveAgentMemoryFilesystemHelper } from '../daemon/agent-memory-helper-release';
import { createAgentMemoryIntentProcessor, helperAgentMemoryIntentBackend } from '../daemon/agent-memory-intent';

const roots: string[] = [];
afterEach(async () => {
  control.mode = undefined;
  control.cas = 0;
  control.fired = false;
  control.last?.kill('SIGKILL');
  control.last = undefined;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

describe.skipIf(process.platform !== 'darwin' || !hasAgentMemoryHelperBuild())('SDK helper process-crash boundaries', () => {
  async function world(operation: 'replace' | 'delete' = 'replace', memoryPath = 'notes/topic.md', options: { root?: string; deviceId?: string } = {}) {
    const root = options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-crash-'));
    roots.push(root);
    const homes = new AgentHomeManager({ hostStorageRoot: root });
    const agentRef = { agentId: 'one', profileRevision: '1' };
    const binding = await homes.prepare(agentRef);
    const home = binding.lease.canonicalHome;
    await binding.lease.release();
    const target = path.join(home, memoryPath);
    if (operation === 'delete') await fs.writeFile(target, 'old');
    const identity = {
      tenantId: 'tenant', deviceId: options.deviceId ?? 'device', intentId: randomUUID(), agentRef,
      path: memoryPath, operation, baseRevision: operation === 'replace' ? sha('') : sha('old'),
      targetRevision: operation === 'replace' ? sha('new') : null, approvalRef: 'approved',
    };
    const intent: AgentMemoryIntentV1 = { intentId: identity.intentId, agentRef, path: memoryPath, operation,
      baseRevision: identity.baseRevision, targetRevision: identity.targetRevision, approvalRef: identity.approvalRef,
      operationDigest: await agentMemoryIntentOperationDigest(identity), ...(operation === 'replace' ? { content: 'new' } : {}),
    };
    const completions: AgentMemoryIntentCompletion[] = [];
    const backend = helperAgentMemoryIntentBackend(resolveAgentMemoryFilesystemHelper());
    const transport = {
      fetch: async (request: { reservation: string }) => ({ disposition: request.reservation === 'none' ? 'deferred' : 'release', intent }),
      complete: async (completion: AgentMemoryIntentCompletion) => {
        completions.push(completion);
        return { tenantId: identity.tenantId, deviceId: identity.deviceId, intentId: identity.intentId,
          disposition: completions.length === 1 ? 'recorded' : 'idempotent', completion, recordedAt: new Date().toISOString() };
      },
    };
    const processor = () => createAgentMemoryIntentProcessor({ tenantId: identity.tenantId, deviceId: identity.deviceId, homes, backend, transport });
    const notice = { intentId: intent.intentId, agentRef };
    const ledger = () => fs.readFile(path.join(home, '.byok/agent-memory-intents-v1.json'), 'utf8').then(raw => JSON.parse(raw).records[0]);
    return { homes, home, agentRef, target, completions, processor, notice, ledger, transport };
  }

  it.each(['applying', 'terminal', 'acked'] as const)('refuses acknowledgement after real helper death before the %s ledger barrier', async stage => {
    const w = await world();
    control.mode = stage;
    await expect(w.processor()(w.notice)).rejects.toMatchObject({ reason: 'local_io_failed' });
    expect(control.fired).toBe(true);
    expect(control.cas).toBe(stage === 'applying' ? 0 : 1);
    expect(w.completions).toHaveLength(stage === 'acked' ? 1 : 0);
    if (stage !== 'applying') expect((await w.ledger()).ackedAt).toBeNull();
    if (stage === 'applying') {
      await expect(fs.stat(w.target)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const before = await fs.stat(w.target, { bigint: true });
      const recovered = await w.processor()(w.notice);
      expect(recovered.kind === 'acknowledged' && recovered.completion.outcome).toBe(stage === 'terminal' ? 'uncertain' : 'applied');
      expect((await fs.stat(w.target, { bigint: true })).ino).toBe(before.ino);
      expect(control.cas).toBe(1);
      expect((await w.ledger()).ackedAt).toEqual(expect.any(String));
    }
  });

  it('reports a lost delete result as uncertain on recovery and never repeats the delete', async () => {
    const w = await world('delete');
    control.mode = 'delete';
    await expect(w.processor()(w.notice)).rejects.toMatchObject({ reason: 'local_io_failed' });
    expect(control.fired).toBe(true);
    expect(control.cas).toBe(1);
    expect(w.completions).toHaveLength(0);
    expect((await w.ledger()).state).toBe('applying');
    await expect(fs.stat(w.target)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await w.processor()(w.notice);
    expect(recovered.kind === 'acknowledged' && recovered.completion.outcome).toBe('uncertain');
    expect(control.cas).toBe(1);
    expect((await w.ledger()).ackedAt).toEqual(expect.any(String));
  });

  it('supports MEMORY.md intent replace and rejects its delete before a helper CAS', async () => {
    const replace = await world('replace', 'MEMORY.md');
    const applied = await replace.processor()(replace.notice);
    expect(applied.kind === 'acknowledged' && applied.completion.outcome).toBe('applied');
    expect(await fs.readFile(replace.target, 'utf8')).toBe('new');
    const remove = await world('delete', 'MEMORY.md');
    const before = control.cas;
    const rejected = await remove.processor()(remove.notice);
    expect(rejected.kind === 'acknowledged' && rejected.completion.outcome).toBe('rejected');
    expect(control.cas).toBe(before);
    expect(await fs.readFile(remove.target, 'utf8')).toBe('old');
  });

  it('keeps the actual daemon cursor before a failed ackedAt barrier, then recovers without another CAS', async () => {
    const server = await TestServer.start();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-cursor-'));
    roots.push(root);
    const storeDir = path.join(root, 'store');
    const hostStorageRoot = path.join(root, 'homes');
    let w: Awaited<ReturnType<typeof world>>;
    const daemon = createDaemonWithAdapters({ productName: 'Helper crash', productId: 'helper-crash', serverUrl: server.url,
      storeDir, storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, agentHome: { hostStorageRoot },
      agentMemoryIntents: { fetch: request => w.transport.fetch(request), complete: completion => w.transport.complete(completion) },
    }, [], { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.setPairingTenantId('pairing-code', 'tenant');
      const record = await daemon.pair('pairing-code');
      w = await world('replace', 'notes/topic.md', { root: hostStorageRoot, deviceId: record.deviceId });
      await daemon.start();
      const hello = await server.waitFor(event => event.type === 'conn.hello');
      expect(hello.type === 'conn.hello' && hello.payload.capabilities).toContain('agent-memory-intent.v1');
      control.mode = 'acked';
      const envelope = createEnvelope('agent.memory.intent.available', w.notice, { seq: server.nextSeq() });
      server.pushLongPollEvent(envelope);
      await vi.waitFor(() => expect(errors.mock.calls.some(args => (args[1] as { reason?: string })?.reason === 'local_io_failed')).toBe(true), { timeout: 5_000 });
      expect(control.fired).toBe(true);
      expect(await new CursorStore(storeDir).load(server.url, record.deviceId)).toBe(0);
      expect((await w.ledger()).ackedAt).toBeNull();
      expect(w.completions).toHaveLength(1);
      const before = await fs.stat(w.target, { bigint: true });
      server.pushLongPollEvent(envelope);
      await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, record.deviceId)).toBe(envelope.seq), { timeout: 5_000 });
      expect((await fs.stat(w.target, { bigint: true })).ino).toBe(before.ino);
      expect(control.cas).toBe(1);
      expect((await w.ledger()).ackedAt).toEqual(expect.any(String));
      expect(w.completions).toHaveLength(2);
      expect(w.completions[1]).toEqual(w.completions[0]);
    } finally { await daemon.stop(); await server.close(); errors.mockRestore(); }
  });

  it('holds the writer lease through timeout until the real stopped helper exits', async () => {
    const w = await world();
    const binding = await w.homes.acquire(w.agentRef);
    const filesystem = await openAgentMemoryFilesystemHelper({ helperBin: resolveAgentMemoryFilesystemHelper(), canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
    const child = control.last!;
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.kill('SIGSTOP');
    try {
      await expect(filesystem.read('MEMORY.md', 1024)).rejects.toThrow('timed out');
      const firstClose = filesystem.close();
      expect(filesystem.close()).toBe(firstClose);
      const closing = firstClose.then(() => binding.lease.release());
      expect(exited).toBe(false);
      await expect(w.homes.acquire(w.agentRef)).rejects.toThrow('mutable writer lease');
      await closing;
      expect(exited).toBe(true);
      const next = await w.homes.acquire(w.agentRef);
      await next.lease.release();
    } finally { child.kill('SIGKILL'); await filesystem.close(); await binding.lease.release(); }
  }, 20_000);
});
