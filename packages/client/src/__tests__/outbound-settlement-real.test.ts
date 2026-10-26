import { testAgentHomeConfig } from './fixtures/test-agent';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { dispatchResumedAgentTask, startRealServer, type RealServerHandle } from './fixtures/real-server';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';

let daemon: Daemon | undefined;
let server: RealServerHandle | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.stop(); await server?.close();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it('default daemon/cloud limits deliver two 40 KiB tool results in separate accepted envelopes', async () => {
  server = await startRealServer({ productId: 'test-product', longPollHoldMs: 20 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settle-real-')); dirs.push(dir);
  const adapter = new StubRuntimeAdapter();
  daemon = createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
    productId: 'test-product', serverUrl: server.url, storeDir: path.join(dir, 'store'),
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } }, [adapter],
    { longPoll: { retryDelayMs: 10, idleDelayMs: 10 } });
  await fs.mkdir(path.join(dir, 'workspace'));
  const record = await daemon.pair((await server.createPairingCode()).code);
  await daemon.start(); await waitForDaemonOpen(daemon);
  const nativeFetch = globalThis.fetch;
  const accepted: Array<{ events: unknown[]; rejected: number }> = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await nativeFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === '/byok/messages' && typeof init?.body === 'string') {
      const batch = JSON.parse(init.body) as { messages: Array<{ type: string; payload: { events?: unknown[] } }> };
      const answer = await response.clone().json() as { rejected?: number };
      for (const envelope of batch.messages) if (envelope.type === 'task.progress' && envelope.payload.events?.some((event) => (event as { type?: string }).type === 'tool_result')) {
        accepted.push({ events: envelope.payload.events, rejected: answer.rejected ?? 0 });
      }
    }
    return response;
  });
  // A resumed Agent task without an egress policy: its activity is batched,
  // not coalesced to the latest value as an egress task's is.
  const { handle, session } = await dispatchResumedAgentTask(server, adapter, { deviceId: record.deviceId, instruction: 'two large results' });
  session.emit({ type: 'tool_result', tool: 'read', output: 'a'.repeat(40 * 1024) });
  session.emit({ type: 'tool_result', tool: 'read', output: 'b'.repeat(40 * 1024) });
  session.emit({ type: 'turn_end' });
  await vi.waitFor(() => expect(daemon!.tasks().some((task) => task.taskId === handle.taskId && task.state === 'Complete')).toBe(true));
  expect(accepted).toHaveLength(2);
  expect(accepted.every((batch) => batch.rejected === 0 && Buffer.byteLength(JSON.stringify(batch.events)) <= 65536)).toBe(true);
  expect(daemon.status().outbound.rejected).toBe(0);
});
