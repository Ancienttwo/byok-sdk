import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
// The built package: its reserved helpers resolve to the shipped dist/bin scripts.
import { CodexAdapter, createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import { TestServer } from './fixtures/test-server';
import { InMemoryDeviceCredentialStore } from './fixtures/device-credentials';

/**
 * Topology H smoke (#468): a CLI daemon and the shipped result helper, no
 * Host code. The fake codex app-server is a real MCP stdio client: it starts
 * the session's `byokagentresult` server from the thread config, lists its
 * tools and calls `submit_result`. The helper fetches the frozen schema over
 * the control socket and forwards the call; the daemon validates, stages and
 * completes the task with the outcome as `task.complete.document`.
 */

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'score'],
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, score: { type: 'integer', minimum: 0, maximum: 10 } },
};

const cleanup: Array<() => Promise<unknown>> = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
  for (const name of ['FAKE_CODEX_SUBMIT_RESULT', 'FAKE_CODEX_MCP_TOOLS_RECEIPT']) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
});

async function run(outcome: unknown) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-result-smoke-')));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const toolsReceipt = path.join(root, 'tools.json');
  process.env.FAKE_CODEX_SUBMIT_RESULT = JSON.stringify(outcome);
  process.env.FAKE_CODEX_MCP_TOOLS_RECEIPT = toolsReceipt;
  const server = await TestServer.start(); cleanup.push(() => server.close());
  const daemon: Daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-result-smoke' }, productName: 'Result smoke', productId: 'result-smoke',
    serverUrl: server.url, storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') },
  }, [new CodexAdapter({ resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }) })], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  cleanup.push(() => daemon.stop());
  await daemon.pair('pairing-code');
  await daemon.start();
  server.send(createEnvelope('task.offer_for_agent', {
    instruction: 'review and submit', runtime: 'codex',
    agentRef: { agentId: 'smoke-agent', profileRevision: '1' },
    terminalProjection: { mode: 'result-document', contract: 'smoke.review.v1', schema: SCHEMA as never },
  }, { taskId: 'smoke-task', seq: server.nextSeq() }));
  const terminal = await server.waitFor((envelope) => envelope.task_id === 'smoke-task'
    && (envelope.type === 'task.complete' || envelope.type === 'task.fail' || envelope.type === 'task.decline'), 20_000);
  return { terminal, tools: JSON.parse(readFileSync(toolsReceipt, 'utf8')) as { tools: Array<Record<string, unknown>> } };
}

it.skipIf(process.platform === 'win32')('a CLI daemon completes with the outcome the runtime submitted through the shipped helper', async () => {
  const { terminal, tools } = await run({ verdict: 'pass', score: 8 });
  expect(tools.tools).toEqual([expect.objectContaining({ name: 'submit_result', inputSchema: SCHEMA })]);
  expect(terminal.type).toBe('task.complete');
  expect(terminal.payload).toMatchObject({ document: { verdict: 'pass', score: 8 } });
}, 30_000);

it.skipIf(process.platform === 'win32')('an outcome outside the frozen schema is refused by the daemon and the task fails result_not_submitted', async () => {
  const { terminal } = await run({ verdict: 'maybe', score: 8 });
  expect(terminal.type).toBe('task.fail');
  expect(terminal.payload).toMatchObject({ retryable: false, reason: expect.stringContaining('result_not_submitted') });
  expect(JSON.stringify(terminal.payload)).not.toContain('"document"');
}, 30_000);
