import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    // Observe the real child without replacing execFile's implementation or
    // its custom promisify contract used by the adapters' authentication probes.
    execFile: Object.assign(vi.fn(actual.execFile), actual.execFile),
  };
});

const dirs: string[] = [];
const children: childProcess.ChildProcess[] = [];
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
function controlledVersionProbe(command: string) {
  // Freeze only the SDK deadline; execFile, streams and OS signals remain real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const exec = vi.mocked(childProcess.execFile);
  exec.mockClear();
  const result = probeRuntimeVersion(command, 1_000);
  const child: childProcess.ChildProcess = exec.mock.results[0]!.value;
  children.push(child);
  return { child, result };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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
      const command=Adapter===CodexAdapter?await executable("if(process.argv[2]==='--version')console.log('codex-cli 0.160.0');else if(process.argv[2]==='app-server')process.exit(0);else process.exit(1);"):good;
      const result = await new Adapter({ resolveBin: () => ({ command, source: 'env' }) }).detect();
      expect(result).toMatchObject({ kind: 'available', version: Adapter===CodexAdapter?'codex-cli 0.160.0':'fixture-v1' });
      expect(await new Adapter({ resolveBin: () => ({ command: bad, source: 'env' }) }).detect()).toEqual({ kind: 'probe-failed' });
    }
  });

  it.skipIf(process.platform === 'win32')('gives every detect probe the task child environment, without CLAUDECODE or BYOK_*', async () => {
    // Synthetic values only. The fixture records names and one synthetic value, never the real env.
    const record = path.join(await directory(), 'probe-env.jsonl');
    const command = await executable(`const fs = require('node:fs');
const flagged = Object.keys(process.env).filter((name) => name === 'CLAUDECODE' || name.startsWith('BYOK_'));
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), flagged, user: process.env.PROBE_USER_SETTING ?? null }) + '\\n');
const arg = process.argv[2];
if (arg === '--version') console.log('codex-cli 0.160.0');
else if (arg === 'auth') console.log('{"loggedIn":true}');
else if (arg === 'login') console.log('Logged in using ChatGPT');`);
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('BYOK_PROBE_SENTINEL', 'synthetic-byok-value');
    vi.stubEnv('PROBE_USER_SETTING', 'synthetic-user-value');
    try {
      for (const Adapter of [ClaudeAdapter, CodexAdapter, PiAdapter]) {
        expect(await new Adapter({ resolveBin: () => ({ command, source: 'env' }) }).detect()).toMatchObject({ kind: 'available' });
      }
    } finally {
      vi.unstubAllEnvs();
    }
    const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; flagged: string[]; user: string | null });
    expect(calls.map((call) => call.argv.join(' '))).toEqual([
      '--version', 'auth status --json',
      '--version', 'app-server --help', 'login status',
      '--version',
    ]);
    for (const call of calls) expect(call).toMatchObject({ flagged: [], user: 'synthetic-user-value' });
  });

  it.skipIf(process.platform === 'win32').each([false, true])('does not relabel output overflow as timeout when ignoring TERM=%s', async (ignoreTerm) => {
    const command = await executable(`${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.on('error', () => {}); process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`);
    const { child, result } = controlledVersionProbe(command);
    const kill = vi.spyOn(child, 'kill');
    const stdout = child.stdout!;
    let bytes = 0;
    stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); });
    // execFile destroys its pipes after detecting maxBuffer, before reaping.
    // Let real I/O establish overflow before advancing the probe's clock.
    await once(stdout, 'close');
    expect(bytes).toBeGreaterThan(1024 * 1024);
    if (ignoreTerm) {
      const settled = vi.fn();
      void result.then(settled);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
    }
    expect(await result).toEqual({ kind: 'probe-failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('reports timeout when the deadline precedes overflow output', async () => {
    const command = await executable("process.stdin.once('data', () => process.stdout.write('x'.repeat(2 * 1024 * 1024))); console.error('ready');");
    const { child, result } = controlledVersionProbe(command);
    let bytes = 0;
    child.stdout!.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); });
    // The child is running but its prospective overflow is still gated on stdin.
    await once(child.stderr!, 'data');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ kind: 'timeout' });
    expect(bytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('owns the timeout and reaps a TERM-ignoring version child', async () => {
    const receipt = path.join(await directory(), 'pid');
    const command = await executable(`require('node:fs').writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`);
    const { child, result } = controlledVersionProbe(command);
    await once(child.stdout!, 'data');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ kind: 'timeout' });
    const pid = Number(await fs.readFile(receipt, 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(vi.getTimerCount()).toBe(0);
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
