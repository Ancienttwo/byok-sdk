// #978 one-off evidence, reverted before merge: the step-6 hard kill, one
// script for the published @byok-sdk/*@0.30.2 packages and for this branch's
// build. AiphaBee's kill9-smoke.ts on the public API: pair a daemon child with
// a hanging runtime, submit one task, hard-kill the daemon after the runtime
// starts (taskkill /F on Windows), restart it and read the device terminal.
// Run from a directory whose node_modules holds @byok-sdk/client,
// @byok-sdk/server and @byok-sdk/protocol.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { deserialize, serialize } from 'node:v8';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner } from '@byok-sdk/server';

const PRODUCT_ID = 'byok-978-taskkill-smoke';
const AGENT_REF = { agentId: 'bot_taskkill', profileRevision: '1' };
// DEFAULT_AGENT_EGRESS_POLICY of 0.30.2 (not exported from the package root).
const EGRESS_POLICY = {
  policyRevision: 'default-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
  reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4 * 1024 * 1024, maxPendingBytesPerTenant: 16 * 1024 * 1024 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};
const TERMINAL_TYPES = new Set(['task.complete', 'task.fail', 'task.cancelled']);
// Wire v4 removed DaemonConfig.workspaceRoot, which 0.30.2 (wire v3) requires,
// and requires an explicit session selection on each execution.
const WIRE_V4 = PROTOCOL_VERSION >= 4;

function fileCredentials(path) {
  const load = () => (existsSync(path) ? deserialize(readFileSync(path)) : undefined);
  const save = (value) => writeFileSync(path, serialize(value));
  const isAttempt = (value) => value !== undefined && value !== null && typeof value === 'object' && 'kind' in value;
  return {
    read: async () => { const a = load(); return isAttempt(a) ? undefined : a; },
    readFirstPairingAttempt: async () => { const a = load(); return isAttempt(a) ? a : undefined; },
    saveFirstPairingAttempt: async (attempt) => save(attempt),
    replace: async (record) => save(record),
    clear: async () => { const had = load() !== undefined; save(undefined); return had; },
  };
}

function hangingRuntime() {
  return {
    descriptor: { id: 'claude', capabilities: { approvalInteractive: false, resume: false, steer: false, mcpToolsets: true }, supportsDispatchSelection: false },
    detect: async () => ({ kind: 'available', authPresent: true }),
    prepare: async () => ({ kind: 'prepared', operation: { start: async () => {
      process.stdout.write(`${JSON.stringify({ event: 'runtime_started' })}\n`);
      let stop = () => {};
      const stopped = new Promise((resolve) => { stop = resolve; });
      return {
        sessionRef: randomBytes(16).toString('hex'),
        events: (async function* () { await stopped; })(),
        close: async () => stop(), interrupt: async () => stop(), steer: async () => {}, followUp: async () => {}, resolveApproval: async () => {},
      };
    } } }),
  };
}

async function daemonMain(root, serverUrl, pairCode) {
  const credentials = fileCredentials(join(root, 'credentials.bin'));
  const daemon = createDaemonWithAdapters({
    productId: PRODUCT_ID, productName: 'byok-sdk #978 taskkill smoke', serverUrl,
    storeDir: join(root, 'device'), ...(WIRE_V4 ? {} : { workspaceRoot: join(root, 'workspaces') }),
    localAgentRelease: { version: '0.0.0', buildId: '0'.repeat(64) },
    agentHome: { hostStorageRoot: join(root, 'homes') }, agentMemoryMcp: 'off',
    agentEgress: { policy: EGRESS_POLICY },
  }, [hangingRuntime()], { deviceCredentials: credentials });
  if (pairCode !== undefined && await credentials.read() === undefined) await daemon.pair(pairCode);
  await daemon.start();
  // start() does not wait for the server; the hello carries the Agent capabilities submit needs.
  await until('daemon open', () => {
    const lifecycle = daemon.status().lifecycle;
    if (lifecycle.phase === 'halted' || lifecycle.phase === 'crashed') throw new Error(`daemon ${lifecycle.phase}: ${lifecycle.reason ?? ''}`);
    return lifecycle.phase === 'running' && lifecycle.connection === 'open' ? true : undefined;
  });
  const record = await credentials.read();
  process.stdout.write(`${JSON.stringify({ event: 'daemon_running', pid: process.pid, deviceId: record?.deviceId, journal: existsSync(join(root, 'device', 'daemon.db')) })}\n`);
}

function spawnDaemon(root, serverUrl, pairCode, onEvent) {
  const child = spawn(process.execPath, [process.argv[1], 'daemon', root, serverUrl, ...(pairCode ? [pairCode] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', (line) => { try { onEvent(JSON.parse(line)); } catch { /* daemon log line */ } });
  return child;
}

async function until(label, read, ms = 60_000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function hardKill(child) {
  if (process.platform !== 'win32') return { command: 'SIGKILL', sent: child.kill('SIGKILL') };
  const result = spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`taskkill failed (${result.status}): ${result.stdout}${result.stderr}`);
  return { command: `taskkill /F /PID ${child.pid}`, output: result.stdout.trim() };
}

/** Terminal envelopes for taskId anywhere in a daemon POST body. */
function terminalsIn(value, taskId, found = []) {
  if (Array.isArray(value)) for (const item of value) terminalsIn(item, taskId, found);
  else if (value !== null && typeof value === 'object') {
    if (TERMINAL_TYPES.has(value.type) && value.task_id === taskId) found.push(value.type);
    else for (const item of Object.values(value)) terminalsIn(item, taskId, found);
  }
  return found;
}

async function hostMain() {
  const root = mkdtempSync(join(tmpdir(), 'byok-978-taskkill-'));
  const server = createByokServer({
    productId: PRODUCT_ID, storage: { kind: 'sqlite', path: join(root, 'server.sqlite') },
    tokenSigner: createHmacTokenSigner(randomBytes(32), { now: () => new Date() }), longPollHoldMs: 100,
  });
  let taskId;
  const acceptedTerminalPosts = [];
  const http = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      const body = Buffer.concat(chunks);
      const result = await server.hono.fetch(new Request(`http://127.0.0.1${request.url}`, { method: request.method ?? 'GET', headers, ...(body.length ? { body } : {}) }));
      if (taskId !== undefined && request.method === 'POST' && result.ok && body.length) {
        try { acceptedTerminalPosts.push(...terminalsIn(JSON.parse(body.toString('utf8')), taskId)); } catch { /* not JSON */ }
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${http.address().port}`;

  const events = [];
  const code = (await server.pairing.createPairingCode({ productId: PRODUCT_ID })).code;
  const first = spawnDaemon(root, serverUrl, code, (event) => events.push({ ...event, run: 1 }));
  const running = await until('first daemon', () => events.find((e) => e.run === 1 && e.event === 'daemon_running'));

  taskId = randomBytes(32).toString('hex');
  await server.executions.submit({ taskId, deviceId: running.deviceId, payload: {
    runtime: 'claude', instruction: '#978 taskkill smoke', agentRef: AGENT_REF, egressPolicy: EGRESS_POLICY, terminalProjection: { mode: 'none' },
    ...(WIRE_V4 ? { session: { mode: 'fresh' } } : {}),
  } });
  await until('runtime start', () => events.find((e) => e.run === 1 && e.event === 'runtime_started'));
  await until('Running snapshot', async () => ((await server.tasks.get(taskId))?.state === 'Running' ? true : undefined));
  const before = { snapshot: await server.tasks.get(taskId), terminal: (await server.tasks.deviceTerminal(taskId)) ?? null };

  const exited = new Promise((resolve) => first.once('exit', (code, signal) => resolve({ code, signal })));
  const kill = hardKill(first);
  const killed = await exited;

  const second = spawnDaemon(root, serverUrl, undefined, (event) => events.push({ ...event, run: 2 }));
  await until('second daemon', () => events.find((e) => e.run === 2 && e.event === 'daemon_running'));
  const terminal = await until('terminal after restart', () => server.tasks.deviceTerminal(taskId));
  // Leave room for a duplicate terminal or a second runtime start to show up.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = await server.tasks.get(taskId);
  second.kill();
  await new Promise((resolve) => second.once('exit', resolve));
  await new Promise((resolve) => http.close(() => resolve()));
  await server.close();

  const summary = {
    node: process.version, platform: process.platform, arch: process.arch, wireV4: WIRE_V4,
    kill, killed, before, terminal: terminal.envelope, after, acceptedTerminalPosts,
    runtimeStarts: { run1: events.filter((e) => e.run === 1 && e.event === 'runtime_started').length, run2: events.filter((e) => e.run === 2 && e.event === 'runtime_started').length },
    daemonEvents: events,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
  const envelope = terminal.envelope;
  const failures = [
    before.snapshot?.state !== 'Running' && 'task was not Running before the kill',
    before.terminal !== null && 'a terminal existed before the kill',
    process.platform === 'win32' && killed.code !== 1 && `taskkill exit was ${JSON.stringify(killed)}`,
    envelope.type !== 'task.fail' && `terminal type ${envelope.type}`,
    envelope.payload?.reason !== 'daemon_interrupted' && `terminal reason ${envelope.payload?.reason}`,
    envelope.payload?.retryable !== false && `terminal retryable ${envelope.payload?.retryable}`,
    acceptedTerminalPosts.length !== 1 && `${acceptedTerminalPosts.length} terminal posts accepted`,
    summary.runtimeStarts.run1 !== 1 && `${summary.runtimeStarts.run1} runtime starts before the kill`,
    summary.runtimeStarts.run2 !== 0 && `${summary.runtimeStarts.run2} runtime starts after the restart`,
  ].filter(Boolean);
  if (failures.length > 0) {
    process.stderr.write(`#978 taskkill smoke FAILED: ${failures.join('; ')}\n`);
    process.exit(1);
  }
  process.stdout.write('#978 taskkill smoke PASSED\n');
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'daemon') await daemonMain(rest[0], rest[1], rest[2]);
else await hostMain();
