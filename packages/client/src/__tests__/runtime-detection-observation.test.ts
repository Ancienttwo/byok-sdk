import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyDetectError, probeRuntimeVersion } from '../adapters/detect-outcome';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { probeRuntimes } from '../bin/runtime-probe';
import { runRuntimesCommand } from '../bin/commands/runtimes';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { collectDiagnostics } from '../diagnostics/diagnostics';
import { validateRuntimeDetectResult } from '../runtime-detection';
import type { RuntimeDetectResult } from '../types';
import type { DaemonConfig } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const dirs: string[] = [];
const secret = 'SENTINEL_PRIVATE_PATH_AND_ERROR';
const kinds = ['available', 'not-found', 'not-executable', 'timeout', 'probe-failed'] as const;
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-probe-'));
  dirs.push(dir);
  return dir;
}
async function executable(body: string): Promise<string> {
  const file = path.join(await directory(), 'probe');
  await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('runtime probe evidence', () => {
  it.each([
    ['ENOENT', 'not-found'], ['EACCES', 'not-executable'], ['EPERM', 'not-executable'],
    ['ENOEXEC', 'not-executable'], [17, 'probe-failed'], ['UNKNOWN', 'probe-failed'],
  ])('maps process code %s without retaining diagnostics', (code, kind) => {
    expect(classifyDetectError({ code, message: secret, stdout: secret, stderr: secret, path: secret })).toEqual({ kind });
  });

  it('never infers timeout from killed or externally signaled processes', () => {
    for (const error of [
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' },
      { killed: true, signal: 'SIGTERM' }, { killed: false, signal: 'SIGKILL' }, secret, null,
    ]) expect(classifyDetectError(error)).toEqual({ kind: 'probe-failed' });
  });

  it.each([ClaudeAdapter, CodexAdapter, PiAdapter])('%s reports a missing executable at the real spawn boundary', async (Adapter) => {
    const command = path.join(await directory(), secret);
    expect(await new Adapter({ resolveBin: () => ({ command, source: 'env' }) }).detect()).toEqual({ kind: 'not-found' });
  });

  it.each([ClaudeAdapter, CodexAdapter, PiAdapter])('%s contains resolver failure without exposing arbitrary error text', async (Adapter) => {
    const result = await new Adapter({ resolveBin: () => { throw new Error(secret); } }).detect();
    expect(result).toEqual({ kind: 'probe-failed' });
  });

  it.skipIf(process.platform === 'win32')('reports executable refusal from the OS, not file-name heuristics', async () => {
    const command = path.join(await directory(), secret);
    await fs.writeFile(command, 'not executable', { mode: 0o600 });
    for (const Adapter of [ClaudeAdapter, CodexAdapter, PiAdapter]) {
      expect(await new Adapter({ resolveBin: () => ({ command, source: 'env' }) }).detect()).toEqual({ kind: 'not-executable' });
    }
  });

  it.skipIf(process.platform === 'win32')('retains successful version/auth behavior and discards both streams on failure', async () => {
    const good = await executable("if (process.argv[2] === '--version') console.log('fixture-v1'); else process.exit(1);");
    const bad = await executable(`console.log('${secret}'); console.error('${secret}'); process.exit(17);`);
    for (const Adapter of [ClaudeAdapter, CodexAdapter, PiAdapter]) {
      const result = await new Adapter({ resolveBin: () => ({ command: good, source: 'env' }) }).detect();
      expect(result).toMatchObject({ kind: 'available', version: 'fixture-v1' });
      expect(await new Adapter({ resolveBin: () => ({ command: bad, source: 'env' }) }).detect()).toEqual({ kind: 'probe-failed' });
    }
  });

  it.skipIf(process.platform === 'win32').each([false, true])('does not relabel output overflow as timeout when ignoring TERM=%s', async (ignoreTerm) => {
    const command = await executable(`${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`);
    expect(await probeRuntimeVersion(command, 1_000)).toEqual({ kind: 'probe-failed' });
  });

  it.skipIf(process.platform === 'win32')('owns the timeout and reaps a TERM-ignoring version child', async () => {
    const receipt = path.join(await directory(), 'pid');
    const command = await executable(`require('node:fs').writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    expect(await probeRuntimeVersion(command, 1_000)).toEqual({ kind: 'timeout' });
    const pid = Number(await fs.readFile(receipt, 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('one runtime detection authoring contract', () => {
  it.each([
    { present: true }, { kind: 'available', present: true }, { kind: 'invented' },
    { kind: 'timeout', version: secret }, { kind: 'probe-failed', message: secret },
    { kind: 'available', version: 123 }, { kind: 'available', authPresent: 'yes' }, null, [],
  ])('rejects malformed or mixed results without translating them: %j', async (value) => {
    expect(() => validateRuntimeDetectResult(value)).toThrow('invalid runtime detection result');
    const adapter = new StubRuntimeAdapter('test', value as RuntimeDetectResult);
    const [result] = await probeRuntimes([adapter]);
    expect(result).toMatchObject({ present: false, outcome: 'probe-failed' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('projects each outcome and bounds custom-adapter silence without fabricating presence', async () => {
    const adapters = kinds.map((kind) => new StubRuntimeAdapter(kind, { kind }));
    const throwing = new StubRuntimeAdapter('throwing');
    throwing.detect = async () => { throw new Error(secret); };
    const silent = new StubRuntimeAdapter('silent');
    silent.detect = () => new Promise<RuntimeDetectResult>(() => {});
    const results = await probeRuntimes([...adapters, throwing, silent], { timeoutMs: 20 });
    expect(results.map(({ outcome }) => outcome)).toEqual([...kinds, 'probe-failed', 'timeout']);
    expect(results.map(({ present }) => present)).toEqual([true, false, false, false, false, false, false]);
    expect(JSON.stringify(results)).not.toContain(secret);
  });

  it('copies the validated result so later custom-adapter mutation cannot change the observation', () => {
    const value = { kind: 'available' as const, version: 'one' };
    const result = validateRuntimeDetectResult(value);
    value.version = 'two';
    expect(result).toEqual({ kind: 'available', version: 'one' });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

it('carries failure outcomes through runtimes/status and doctor JSON/text without private diagnostics', async () => {
  const dir = await directory();
  const config: DaemonConfig = {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Probe', productId: 'probe-product',
    serverUrl: 'http://example.invalid', workspaceRoot: dir, storeDir: dir,
  };
  const adapters = kinds.map((kind) => new StubRuntimeAdapter(kind, { kind }));
  const connectControl = async () => ({ ok: false as const, reason: 'offline' });
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  await runRuntimesCommand(config, { adapters, log });
  await runStatusCommand(config, { adapters, log, connectControl });
  for (const kind of kinds.filter((kind) => kind !== 'available')) {
    expect(lines).toContain(`${kind}: ${kind}`);
    expect(lines.find((line) => line.startsWith('runtimes:'))).toContain(`${kind}=${kind}`);
  }
  const snapshot = await collectDiagnostics(config, dir, { adapters, connectControl });
  expect(snapshot.runtimes.map(({ outcome }) => outcome)).toEqual(kinds);
  expect(snapshot.runtimes.map(({ present }) => present)).toEqual([true, false, false, false, false]);
  const check = snapshot.checks.find(({ id }) => id === 'runtimes');
  expect(check?.status).toBe('pass');
  expect(check?.summary).toBe('1/5 present; not-found=1 not-executable=1 timeout=1 probe-failed=1');
  await runDoctorCommand(config, { adapters, connectControl, log });
  expect(lines.some((line) => line.includes(check!.summary))).toBe(true);
  const json: string[] = [];
  await runDoctorCommand(config, { adapters, connectControl, json: true, log: (line) => { json.push(line); } });
  expect(JSON.parse(json[0]!).diagnostics.runtimes.map((runtime: { outcome: string }) => runtime.outcome)).toEqual(kinds);
  expect(json.join('')).not.toContain(secret);
});
