import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgyAdapter, CodexAdapter, createRuntimeAdapters } from '../adapters/index.js';
import { findRuntimeCommandOnPath, runtimeInvocationHost } from '../adapters/runtime-invocation.js';
import { detectRuntimes } from '../daemon/create-daemon/support.js';
import { createDaemonRecordProjector } from '../daemon/daemon-record.js';
import { unmeasuredRetentionSnapshot } from '../daemon/retention/sweeper.js';
import { formatLiveStatusLines } from '../diagnostics/format.js';
import { parseControlStatusRuntimes } from '../runtime-detection.js';
import { createRuntimeReaders } from '../runtime/runtime-readers.js';
import { agyAdapterWithEndpoint } from '../adapters/antigravity/agy-endpoint.js';
import { startLoopbackProvider, CONTRACT_REPLY_CHUNKS } from './runtime-contract/loopback.js';

const dirs: string[] = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-readers-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const credential = 'reader-api-secret-value';
const codexFixture = String.raw`
const readline = require('node:readline');
const [version, mode, command] = process.argv.slice(1);
if (command === '--version') { console.log('codex-cli ' + version); process.exit(0); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const key = process.env.READER_API_KEY;
  const replies = {
    initialize: {},
    'model/list': { data: [{ model: 'test-model', displayName: 'display-' + key,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low',
      serviceTiers: [{ id: 'priority', name: 'Priority', description: 'tier-' + key },
        { id: 'priority', name: 'Duplicate' }, { id: 'fast' }] }] },
    'config/read': { config: { model: 'test-model' } },
    'account/read': { account: { type: 'chatgpt' } },
    'account/rateLimits/read': { rateLimits: { limitId: 'codex', planType: 'test-plan', primary: { usedPercent: 25 } } },
  };
  if (mode === 'wait') return;
  const response = mode === 'error'
    ? { id: request.id, error: { code: -32603, message: 'failed ' + key } }
    : { id: request.id, result: replies[request.method] };
  console.log(JSON.stringify(response));
});`;

function codexHarness() {
  let mode = 'ok';
  let version = '0.164.0';
  let executable = process.execPath;
  const environments: unknown[] = [];
  const children: Array<ReturnType<typeof spawn>> = [];
  vi.stubEnv('READER_API_KEY', credential);
  vi.stubEnv('READER_DAEMON_ONLY', 'daemon-only-value');
  const adapter = new CodexAdapter({
    resolveBin: () => ({ command: executable, source: 'env' }),
    runtimeEnvironment: { base: 'allowlist', allow: ['READER_API_KEY'] },
    spawnFn: ((_command: string, args: readonly string[], options: SpawnOptions) => {
      environments.push(options.env);
      const child = spawn(process.execPath, ['-e', codexFixture, '--', version, mode, ...args], options);
      if (args[0] === 'app-server') children.push(child);
      return child;
    }) as typeof spawn,
  });
  return { adapter, children, environments, setMode: (value: string) => { mode = value; },
    setVersion: (value: string) => { version = value; }, setExecutable: (value: string) => { executable = value; } };
}

it('queries the catalog and quota in process using only the filtered runtime environment', async () => {
  const { adapter, environments } = codexHarness();
  vi.stubEnv('BYOK_TOOL_AUTHORIZATION_GATE', 'private-gate-credential');
  await expect(adapter.listModels()).resolves.toEqual({ kind: 'ok', models: [{ id: 'test-model', displayName: 'display-[redacted]',
    effortLevels: ['low', 'high'], defaultEffort: 'low', default: true, serviceTiers: ['priority', 'fast'],
    serviceTierDetails: [{ id: 'priority', displayName: 'Priority', description: 'tier-[redacted]' }, { id: 'fast' }] }] });
  await expect(adapter.accountUsage()).resolves.toMatchObject({ kind: 'available', plan: 'test-plan', windows: [{ usedRatio: 0.25 }] });
  const { env } = await adapter.runtimeEnvironment();
  expect(env.READER_API_KEY).toBe(credential);
  expect(environments).toEqual([env, env, env, env]);
  expect(env).not.toHaveProperty('READER_DAEMON_ONLY');
  expect(env).not.toHaveProperty('BYOK_TOOL_AUTHORIZATION_GATE');
});

it('caches only usable catalogs for the current executable and version and honors refresh', async () => {
  const { adapter, children, setVersion, setExecutable } = codexHarness();
  const first = await adapter.listModels();
  if (first.kind !== 'ok') throw new Error('expected a catalog');
  (first.models[0] as { displayName: string }).displayName = 'caller mutation';
  expect(await adapter.listModels()).toMatchObject({ models: [{ displayName: 'display-[redacted]' }] });
  expect(children).toHaveLength(1);
  await adapter.listModels({ refresh: true });
  expect(children).toHaveLength(2);
  setVersion('0.165.0');
  await adapter.listModels();
  expect(children).toHaveLength(3);
  setExecutable(path.join(await tempDir(), 'alternate-codex'));
  await adapter.listModels();
  expect(children).toHaveLength(4);
});

it('discards native errors and kills the owned reader when cancelled', async () => {
  const { adapter, children, setMode } = codexHarness();
  setMode('error');
  await expect(adapter.listModels()).rejects.toEqual(new Error('runtime reader failed'));
  setMode('wait');
  const controller = new AbortController();
  const read = adapter.listModels({ signal: controller.signal });
  const rejected = expect(read).rejects.toThrow('runtime read cancelled');
  await vi.waitFor(() => expect(children).toHaveLength(2));
  const ended = new Promise<void>(resolve => children[1]!.once('close', () => resolve()));
  controller.abort();
  await rejected;
  await ended;
  expect(children[1]!.signalCode).not.toBeNull();
});

it('closes the reader environment when redactor setup fails', async () => {
  const { adapter } = codexHarness();
  const close = vi.fn(async () => {});
  const readers = createRuntimeReaders(adapter, {
    command: () => process.execPath,
    version: () => undefined,
    environment: async () => ({
      env: { get BROKEN_KEY(): string { throw new Error('redactor setup failed'); } },
      close,
    }),
  });
  await expect(readers.listModels({}, vi.fn())).rejects.toThrow('redactor setup failed');
  expect(close).toHaveBeenCalledTimes(1);
});

it('closes the reader environment when an in-flight reader is cancelled', async () => {
  const { adapter } = codexHarness();
  const close = vi.fn(async () => {});
  const readers = createRuntimeReaders(adapter, {
    command: () => process.execPath,
    version: () => undefined,
    environment: env => ({ env, close }),
  });
  const reader = vi.fn(() => new Promise<never>(() => {}));
  const controller = new AbortController();
  const rejected = expect(readers.listModels({ signal: controller.signal }, reader)).rejects.toThrow('runtime read cancelled');
  await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it('closes the reader environment if it arrives after cancellation', async () => {
  const { adapter } = codexHarness();
  const close = vi.fn(async () => {});
  const environmentResult = Promise.withResolvers<{ env: Record<string, string>; close: typeof close }>();
  const environment = vi.fn(() => environmentResult.promise);
  const readers = createRuntimeReaders(adapter, { command: () => process.execPath, version: () => undefined, environment });
  const controller = new AbortController();
  const rejected = expect(readers.listModels({ signal: controller.signal }, vi.fn())).rejects.toThrow('runtime read cancelled');
  await vi.waitFor(() => expect(environment).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
  environmentResult.resolve({ env: {}, close });
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it.skipIf(process.platform === 'win32')('builds unpaired catalog adapters through the public factory', async () => {
  const dir = await tempDir();
  const executable = path.join(dir, 'codex');
  await fs.writeFile(executable, '#!/bin/sh\nexec "$TEST_NODE" -e "$TEST_READER" -- 0.164.0 ok "$@"\n', { mode: 0o700 });
  vi.stubEnv('BYOK_CODEX_BIN', executable);
  vi.stubEnv('TEST_NODE', findRuntimeCommandOnPath('node', runtimeInvocationHost(process.env)) ?? process.execPath);
  vi.stubEnv('TEST_READER', codexFixture);
  const [adapter] = createRuntimeAdapters({ runtimeAllowlist: ['codex'], runtimeEnvironment: { base: 'allowlist', allow: ['TEST_NODE', 'TEST_READER'] } });
  await expect(adapter!.listModels!()).resolves.toMatchObject({ kind: 'ok', models: [{ id: 'test-model' }] });
  await expect(adapter!.accountUsage!()).resolves.toMatchObject({ kind: 'available' });
});

it.skipIf(process.platform === 'win32')('reads Antigravity effort menus and keeps its remote auth probe on the usage path', async () => {
  const script = String.raw`
const readline = require('node:readline');
const [command] = process.argv.slice(1);
if (command === '--version') { console.log('1.5.9'); process.exit(0); }
if (command === 'models') { console.error('Please sign in'); process.exit(1); }
let current = 'model-a';
function options() {
  return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
    options: ['model-a', 'model-b'].map(value => ({ value, name: value })) },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low',
      options: ['low', 'high'].map(value => ({ value, name: value })) }];
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const result = request.method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'read-only-session', configOptions: options() };
  const reply = request.method === 'session/set_config_option' && request.params.value === 'model-b'
    ? { error: { code: -32603, message: 'unconfirmed model' } }
    : { result };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }));
});`;
  const dir = await tempDir();
  const argsSeen: string[] = [];
  const key = 'gemini-credential-test-value';
  vi.stubEnv('GEMINI_API_KEY', 'ambient-gemini-key');
  const resolveKey = vi.fn(async () => key);
  const proxies: string[] = [];
  const tokens: string[] = [];
  const adapter = new AgyAdapter({ home: path.join(dir, 'owned'), resolveKey, resolveBin: () => ({ command: process.execPath, source: 'env' }),
    runtimeEnvironment: { base: 'allowlist', allow: ['GEMINI_API_KEY'] },
    spawnFn: ((_command: string, args: readonly string[], options: SpawnOptions) => {
      argsSeen.push(args[0]!);
      expect(options.env?.GEMINI_API_KEY).not.toBe(key);
      if (args[0] === '--version') {
        expect(options.env?.GEMINI_API_KEY).toBeUndefined();
      } else {
        expect(options.env?.GEMINI_API_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
        tokens.push(options.env!.GEMINI_API_KEY!);
        proxies.push(options.env!.GOOGLE_GEMINI_BASE_URL!);
      }
      return spawn(process.execPath, ['-e', script, '--', ...args], options);
    }) as typeof spawn,
  });
  await expect(adapter.listModels()).resolves.toEqual({ kind: 'ok', models: [
    { id: 'model-a', default: true, effortLevels: ['low', 'high'], defaultEffort: 'low' },
    { id: 'model-b', effortUnavailableReason: 'Native model selection did not return a confirmed effort menu.' },
  ] });
  await expect(adapter.listModels()).resolves.toMatchObject({ kind: 'ok' });
  expect(argsSeen).toEqual(['--version', 'acp', '--version']);
  expect(resolveKey).toHaveBeenCalledTimes(1);
  await expect(adapter.accountUsage()).resolves.toEqual({ kind: 'reauth_required', reason: 'not_authenticated' });
  expect(argsSeen).toEqual(['--version', 'acp', '--version', '--version', 'models']);
  expect(resolveKey).toHaveBeenCalledTimes(2);
  expect(new Set(tokens).size).toBe(2);
  for (const url of proxies) await expect(fetch(url)).rejects.toThrow();
  expect(process.env.GEMINI_API_KEY).toBe('ambient-gemini-key');
});

it.each([false, true])('resolves a fresh agy key per quota command (exhausted=%s)', async exhausted => {
  const provider = await startLoopbackProvider('gemini', () => ({ kind: 'text', chunks: CONTRACT_REPLY_CHUNKS }));
  const childScript = String.raw`
const [ratio, command, query] = process.argv.slice(1);
if (command === '--version') { console.log('1.5.9'); process.exit(0); }
fetch(process.env.GOOGLE_GEMINI_BASE_URL + '/v1beta/models', { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }).then(async response => {
  if (!response.ok) process.exit(1);
  await response.text();
  if (command === 'models') return;
  console.log(JSON.stringify({ status: 'SUCCESS', command: query === '/usage'
    ? { name: 'usage', data: { groups: [{ name: 'Shared', buckets: [{ remaining_fraction: Number(ratio) }] }] } }
    : { name: 'credits', data: { remaining_credits: 0 } } }));
}).catch(() => process.exit(1));`;
  const resolved: string[] = [];
  const proxies: string[] = [];
  const commands: string[][] = [];
  const adapter = agyAdapterWithEndpoint(new AgyAdapter({
    home: path.join(await tempDir(), 'owned'),
    resolveKey: async () => {
      const key = `quota-fixture-credential-${resolved.length}`;
      resolved.push(key);
      return key;
    },
    resolveBin: () => ({ command: process.execPath, source: 'env' }),
    runtimeEnvironment: { base: 'allowlist' },
    spawnFn: ((_command: string, args: readonly string[], options: SpawnOptions) => {
      if (options.env?.GOOGLE_GEMINI_BASE_URL !== undefined) proxies.push(options.env.GOOGLE_GEMINI_BASE_URL);
      commands.push([...args]);
      return spawn(process.execPath, ['-e', childScript, '--', exhausted ? '0' : '0.5', ...args], options);
    }) as typeof spawn,
  }), provider.origin);
  try {
    await expect(adapter.accountUsage()).resolves.toMatchObject({ kind: 'available', rateLimited: exhausted });
    expect(commands.map(args => args[0] === '-p' ? args[1] : args[0])).toEqual(['--version', 'models', '/usage', ...(exhausted ? ['/credits'] : [])]);
    expect(resolved).toHaveLength(exhausted ? 3 : 2);
    expect(provider.requests.map(request => request.apiKey)).toEqual(resolved);
    for (const url of proxies) await expect(fetch(url)).rejects.toThrow();
  } finally {
    await provider.close();
  }
});

it.skipIf(process.platform === 'win32')('keeps native version floor evidence local to status and doctor', async () => {
  const dir = await tempDir();
  const executable = path.join(dir, 'agy');
  await fs.writeFile(executable, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "1.4.9\\n"\n', { mode: 0o700 });
  const adapter = new AgyAdapter({ home: path.join(dir, 'owned'), resolveKey: async () => 'fixture-key', resolveBin: () => ({ command: executable, source: 'env' }),
    runtimeEnvironment: { base: 'allowlist' } });
  const { observations, ...hello } = await detectRuntimes([adapter]);
  const versions = { installedVersion: '1.4.9', requiredVersion: '1.5.0' };
  expect(parseControlStatusRuntimes({ runtimes: observations })?.[0]?.unsupportedVersion).toEqual(versions);
  const lines = formatLiveStatusLines({
    pid: 1, uptimeMs: 1, paired: true, lifecycle: { phase: 'running', connection: 'open' }, runtimes: observations,
    toolsets: { revision: '1', toolsets: [] },
    outbound: { accepted: 0, duplicate: 0, rejected: 0, rejectedTerminals: 0, droppedEphemeral: 0, rejectedByReason: {} },
    operationalHealth: { availability: 'available', state: 'healthy', failureCount: 0, failureThreshold: 1, windowMs: 1000, crashCount: 0 },
    activeTasks: [], approvals: [], approvalsPending: 0, queueWatermarks: [], storage: unmeasuredRetentionSnapshot(),
  });
  expect(lines).toContain('live-runtimes: agy=refused:version_unsupported(installedVersion=1.4.9 requiredVersion=1.5.0)');
  const audit = createDaemonRecordProjector().project({ kind: 'runtimes-detected', ts: new Date().toISOString(), runtimes: observations });
  for (const projection of [hello, audit]) {
    expect(JSON.stringify(projection)).not.toMatch(/installedVersion|requiredVersion|1\.4\.9|1\.5\.0/);
  }
});
