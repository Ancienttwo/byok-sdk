import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_MAX_SNAPSHOT_BYTES, AGENT_MEMORY_MAX_SNAPSHOT_FILES, type AgentRef } from '@byok-sdk/protocol';
import { AgentHomeBusyError, AgentHomeManager } from '../agent-home';
import { AgentMemoryService, AgentMemorySnapshotLimitError, AgentMemoryValidationError } from '../daemon/agent-memory';
import { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
import { createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { testScratchRoot } from './fixtures/execution-scratch';

const AGENT: AgentRef = { agentId: 'export-synthetic', profileRevision: '3' };
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const roots: string[] = [];
const helperBin = builtAgentMemoryFilesystemHelperBin();
// The fixture returns a helper only on a helper platform (macOS, Windows x64).
const supported = process.platform === 'linux' || helperBin !== undefined;
if (process.env.BYOK_REQUIRE_MEMORY_EXPORT_TESTS === '1' && !supported) throw new Error('memory export native backend qualification is required');
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function harness(enabled = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-memory-export-'))); roots.push(root);
  const hostStorageRoot = path.join(root, 'homes');
  const projection = { prepare: vi.fn() };
  const config: DaemonConfig = {
    productId: 'export-test', productName: 'Export test', serverUrl: 'http://localhost:1',
    localAgentRelease: { version: '0.0.0-test' },
    storeDir: path.join(root, 'store'), storage: { scratchRoot: testScratchRoot() },
    agentHome: { hostStorageRoot, projection }, agentMemoryMcp: 'off',
    ...(enabled ? { agentMemoryExport: true } : {}),
  };
  return { root, config, projection, homes: new AgentHomeManager({ hostStorageRoot }), daemon: createDaemonWithAdapters(config, []) };
}

it('omits the raw export entry without explicit opt-in', async () => {
  const { daemon, config } = await harness(false);
  expect(Object.hasOwn(daemon, 'exportAgentMemory')).toBe(false);
  expect(() => createDaemonWithAdapters({ ...config, agentMemoryExport: false } as unknown as DaemonConfig, [])).toThrow('must be true');
});

describe.skipIf(!supported)('native task-free raw memory export (synthetic homes only)', () => {
  it('initializes an empty home, with no network, task, audit or Host projection side effects', async () => {
    const { daemon, root, projection } = await harness();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const events = vi.fn(); daemon.subscribe(events);
    const first = await daemon.exportAgentMemory!(AGENT);
    expect(first.files).toEqual([{ path: 'MEMORY.md', revision: sha(''), byteCount: 0, content: '' }]);
    expect(first.requestedAgentRef).toEqual(AGENT);
    expect(first.appliedProfileRevision).toBeUndefined();
    expect(await daemon.exportAgentMemory!(AGENT)).toEqual(first);
    expect(network).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(projection.prepare).not.toHaveBeenCalled();
    expect(daemon.tasks()).toEqual([]);
    await expect(fs.stat(path.join(root, 'homes/agents', AGENT.agentId, '.byok/agent-memory-audit-v1.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports exact memory_save revisions and a deterministic path-ordered digest', async () => {
    const { daemon, homes } = await harness();
    const binding = await homes.acquire(AGENT);
    let filesystem;
    const saved = new Map<string, string | undefined>();
    try {
      await homes.initializeTaskFree(binding);
      if (helperBin !== undefined) filesystem = await openAgentMemoryFilesystemHelper({ helperBin, canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
      const service = new AgentMemoryService({ taskId: 'synthetic-task', tenantId: 'synthetic-tenant', deviceId: 'synthetic-device',
        agentRef: AGENT, sessionRef: 'synthetic-session', runtimeId: 'pi', leaseId: binding.lease.leaseId,
        canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity, ...(filesystem === undefined ? {} : { filesystem }) });
      for (const [file, content] of [['notes/z.md', '中文\n'], ['notes/A.md', 'A\n'], ['MEMORY.md', 'synthetic memory']]) {
        saved.set(file!, (await service.save({ op: 'replace', path: file, content, expectedRevision: sha('') })).revision);
      }
    } finally { try { await filesystem?.close(); } finally { await binding.lease.release(); } }
    const result = await daemon.exportAgentMemory!(AGENT);
    expect(result.files.map(file => file.path)).toEqual(['MEMORY.md', 'notes/A.md', 'notes/z.md']);
    for (const file of result.files) { expect(file.revision).toBe(saved.get(file.path)); expect(file.byteCount).toBe(Buffer.byteLength(file.content)); }
    expect(result.snapshotDigest).toBe(sha(JSON.stringify(['byok-agent-memory-export.v1', result.files.map(file => [file.path, file.revision, file.byteCount])])));
    expect((await daemon.exportAgentMemory!(AGENT)).snapshotDigest).toBe(result.snapshotDigest);
  });

  it('rejects an active writer with typed busy, then succeeds after release', async () => {
    const { daemon, homes } = await harness();
    const writer = await homes.acquireExecution(AGENT, { taskId: 'busy-synthetic' });
    try { await expect(daemon.exportAgentMemory!(AGENT)).rejects.toBeInstanceOf(AgentHomeBusyError); }
    finally { await writer.lease.release(); }
    await expect(daemon.exportAgentMemory!(AGENT)).resolves.toHaveProperty('snapshotDigest');
  });

  it('rejects a mismatched applied profile and returns observed metadata only when present', async () => {
    const { daemon, homes } = await harness();
    const binding = await homes.acquire(AGENT);
    try {
      await homes.initializeTaskFree(binding);
      await fs.mkdir(path.join(binding.lease.canonicalHome, '.byok'), { recursive: true });
      await fs.writeFile(path.join(binding.lease.canonicalHome, '.byok/agent-home-projection.json'), JSON.stringify({
        version: 1, agentRef: AGENT, requestId: 'synthetic-projection', projectionHash: sha('synthetic'),
      }));
    } finally { await binding.lease.release(); }
    await expect(daemon.exportAgentMemory!({ ...AGENT, profileRevision: '2' })).rejects.toBeInstanceOf(AgentMemoryValidationError);
    expect((await daemon.exportAgentMemory!(AGENT)).appliedProfileRevision).toBe('3');
  });

  it.each(['files', 'bytes'] as const)('rejects excessive %s without a partial result, and releases the lease', async limit => {
    const { daemon, homes } = await harness();
    await daemon.exportAgentMemory!(AGENT);
    const binding = await homes.acquire(AGENT);
    const notes = path.join(binding.lease.canonicalHome, 'notes');
    try {
      const count = limit === 'files' ? AGENT_MEMORY_MAX_SNAPSHOT_FILES : 5;
      const content = limit === 'files' ? '' : 'x'.repeat(AGENT_MEMORY_MAX_SNAPSHOT_BYTES / 4);
      for (let i = 0; i < count; i++) await fs.writeFile(path.join(notes, `n${i}.md`), content);
    } finally { await binding.lease.release(); }
    await expect(daemon.exportAgentMemory!(AGENT)).rejects.toBeInstanceOf(AgentMemorySnapshotLimitError);
    await fs.rm(notes, { recursive: true }); await fs.mkdir(notes);
    await expect(daemon.exportAgentMemory!(AGENT)).resolves.toHaveProperty('totalBytes', 0);
  });

  it('honors pre-abort without creating a home and releases the lease on mid-operation abort', async () => {
    const { daemon, root } = await harness();
    const signal = AbortSignal.abort(new Error('synthetic abort'));
    await expect(daemon.exportAgentMemory!(AGENT, { signal })).rejects.toThrow('synthetic abort');
    await expect(fs.stat(path.join(root, 'homes/agents', AGENT.agentId))).rejects.toMatchObject({ code: 'ENOENT' });
    const abort = new AbortController();
    const original = AgentHomeManager.prototype.initializeTaskFree;
    const spy = vi.spyOn(AgentHomeManager.prototype, 'initializeTaskFree').mockImplementation(async function(this: AgentHomeManager, binding) {
      await original.call(this, binding); abort.abort(new Error('mid abort'));
    });
    await expect(daemon.exportAgentMemory!(AGENT, { signal: abort.signal })).rejects.toThrow('mid abort');
    spy.mockRestore();
    await expect(daemon.exportAgentMemory!(AGENT)).resolves.toHaveProperty('totalBytes', 0);
  });
});
