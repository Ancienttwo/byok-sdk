import { CursorStore } from '../daemon/cursor-store';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import { createEnvelope, type AgentMemoryIntentV1, type AgentMemoryIntentCompletion } from '@byok-sdk/protocol';
import { expect, it, vi } from 'vitest';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { copyAgentMemoryHelperAssets, resolveAgentMemoryFilesystemHelper } from '../daemon/agent-memory-helper-release';
import * as helperClient from '../daemon/agent-memory-fs-helper';
import { hasAgentMemoryHelperBuild } from './fixtures/agent-memory-helper-build';
import { testScratchRoot } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

// Only the macOS helper has B. Windows x64 admits task MCP recall and save and never advertises intents.
const intents = process.platform === 'darwin';

it.skipIf(!helperClient.isAgentMemoryFilesystemHelperSupported() || !hasAgentMemoryHelperBuild())('uses the copied root for daemon volume probe, intent and task MCP with real helper I/O', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-assets-daemon-'));
  const assetRoot = path.join(root, 'assets');
  const server = await TestServer.start();
  const client = new Client({ name: 'relocated-memory-test', version: '1' }, { capabilities: {} });
  const open = vi.spyOn(helperClient, 'openAgentMemoryFilesystemHelper'); // observe real calls; never replace the backend
  let daemon: ReturnType<typeof createDaemonWithAdapters> | undefined;
  try {
    await copyAgentMemoryHelperAssets({ outDir: assetRoot, platform: process.platform === 'win32' ? 'win32' : 'darwin' });
    const helperBin = resolveAgentMemoryFilesystemHelper(assetRoot);
    const entry = path.join(root, 'host.mjs');
    const sdk = new URL('../../dist/index.js', import.meta.url).href;
    await fs.writeFile(entry, `import { runSdkReservedHelperCommand } from ${JSON.stringify(sdk)};\nif (!await runSdkReservedHelperCommand(process.argv.slice(2))) throw new Error('not an SDK helper');\n`);
    const adapter = new StubRuntimeAdapter('pi', undefined, { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true });
    const agentRef = { agentId: 'relocated', profileRevision: '1' };
    let intent: AgentMemoryIntentV1;
    let deviceId: string;
    const completions: AgentMemoryIntentCompletion[] = [];
    daemon = createDaemonWithAdapters({
      productId: 'relocated-memory', productName: 'Relocated memory', serverUrl: server.url,
      storeDir: path.join(root, 'store'), localAgentRelease: { version: '0.0.0-test' }, storage: { scratchRoot: testScratchRoot() },
      sdkHelperHost: { mode: 'self-executable', executable: process.execPath, entry },
      agentHome: { hostStorageRoot: path.join(root, 'homes') }, agentMemoryHelperAssetRoot: assetRoot,
      agentMemoryIntents: {
        fetch: async request => ({ disposition: request.reservation === 'none' ? 'deferred' : 'release', intent }),
        complete: async completion => {
          completions.push(completion);
          return { tenantId: 'tenant', deviceId, intentId: intent.intentId, disposition: 'recorded', completion, recordedAt: new Date().toISOString() };
        },
      },
    }, [adapter], { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
    server.setPairingTenantId('pairing-code', 'tenant');
    deviceId = (await daemon.pair('pairing-code')).deviceId;
    const identity = { tenantId: 'tenant', deviceId, intentId: randomUUID(), agentRef, path: 'MEMORY.md', operation: 'replace' as const,
      baseRevision: sha(''), targetRevision: sha('intent from copied assets'), approvalRef: 'approved' };
    intent = { intentId: identity.intentId, agentRef, path: identity.path, operation: identity.operation,
      baseRevision: identity.baseRevision, targetRevision: identity.targetRevision, approvalRef: identity.approvalRef,
      operationDigest: await agentMemoryIntentOperationDigest(identity), content: 'intent from copied assets' };
    await daemon.start();
    const hello = await server.waitFor(event => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    if (intents) {
      expect(hello.payload.capabilities).toContain('agent-memory-intent.v1');
      expect(open.mock.calls.some(([input]) => input.canonicalHome === path.join(root, 'homes'))).toBe(true);
      const notice = createEnvelope('agent.memory.intent.available', { intentId: intent.intentId, agentRef }, { seq: server.nextSeq() });
      server.pushLongPollEvent(notice);
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      expect(completions[0]!.outcome).toBe('applied');
      await vi.waitFor(async () => expect(await new CursorStore(path.join(root, 'store')).load(server.url, deviceId)).toBe(notice.seq));
    } else {
      // No B: no volume probe and no capability.
      expect(hello.payload.capabilities).not.toContain('agent-memory-intent.v1');
      expect(open).not.toHaveBeenCalled();
    }
    const seeded = intents ? 'intent from copied assets' : '';
    server.pushLongPollEvent(createEnvelope('task.offer_for_agent', { instruction: 'Use local memory', runtime: 'pi', agentRef },
      { taskId: 'relocated-memory-task', seq: server.nextSeq() }));
    const started = await server.waitFor(event => event.task_id === 'relocated-memory-task' && (event.type === 'task.started' || event.type === 'task.decline'));
    expect(started.type, JSON.stringify(started.payload)).toBe('task.started');
    const mcp = adapter.startCalls[0]!.ctx.mcpServers!.byokagentmemory!;
    await client.connect(new StdioClientTransport({ command: mcp.command, args: [...(mcp.args ?? [])], env: { ...mcp.env, PATH: process.env.PATH! } }));
    const recall = await client.callTool({ name: 'memory_recall', arguments: { path: 'MEMORY.md' } });
    // Windows starts from the empty file, so its recall names the empty revision.
    expect(JSON.stringify(recall)).toContain(intents ? seeded : sha(seeded));
    expect(recall.isError).not.toBe(true);
    const save = await client.callTool({ name: 'memory_save', arguments: { op: 'replace', path: 'MEMORY.md', expectedRevision: sha(seeded), content: 'saved through MCP' } });
    expect(save.isError).not.toBe(true);
    expect(JSON.stringify(await client.callTool({ name: 'memory_recall', arguments: { path: 'MEMORY.md' } }))).toContain('saved through MCP');
    expect(open.mock.calls.length).toBeGreaterThanOrEqual(intents ? 3 : 1);
    for (const [input] of open.mock.calls) expect(input).toMatchObject({ assetRoot, helperBin });
  } finally {
    await client.close();
    await daemon?.stop();
    await server.close();
    open.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
