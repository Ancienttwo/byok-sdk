import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgyAdapter, CodexAdapter, createRuntimeAdapters } from '../adapters/index.js';
import { findRuntimeCommandOnPath, runtimeInvocationHost } from '../adapters/runtime-invocation.js';
import { detectRuntimes } from '../daemon/create-daemon/support.js';
import { createDaemonRecordProjector } from '../daemon/daemon-record.js';
import { formatRuntimeLines } from '../diagnostics/format.js';
import { parseControlStatusRuntimes } from '../runtime-detection.js';

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
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }] },
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
    effortLevels: ['low', 'high'], defaultEffort: 'low', default: true }] });
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

it.skipIf(process.platform === 'win32')('keeps native version floor evidence local to status and doctor', async () => {
  const dir = await tempDir();
  const executable = path.join(dir, 'agy');
  await fs.writeFile(executable, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "1.4.9\\n"\n', { mode: 0o700 });
  const adapter = new AgyAdapter({ home: path.join(dir, 'owned'), resolveBin: () => ({ command: executable, source: 'env' }),
    runtimeEnvironment: { base: 'allowlist' } });
  const { observations, ...hello } = await detectRuntimes([adapter]);
  const versions = { installedVersion: '1.4.9', requiredVersion: '1.5.0' };
  expect(parseControlStatusRuntimes({ runtimes: observations })?.[0]?.unsupportedVersion).toEqual(versions);
  expect(formatRuntimeLines(observations)).toEqual(['agy: refused:version_unsupported installedVersion=1.4.9 requiredVersion=1.5.0']);
  const audit = createDaemonRecordProjector().project({ kind: 'runtimes-detected', ts: new Date().toISOString(), runtimes: observations });
  for (const projection of [hello, audit]) {
    expect(JSON.stringify(projection)).not.toMatch(/installedVersion|requiredVersion|1\.4\.9|1\.5\.0/);
  }
});
