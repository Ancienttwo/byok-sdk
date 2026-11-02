// DIAG #1364 (do not merge). E5 arms, outside Vitest so no test timeout is touched.
//   complete: the cold ACL probe runs to completion (no cancel), then 3 warm probes.
//   killtree: the cold probe is killed with its whole tree (taskkill /T /F) at 29.8s, then 3 warm probes.
// Every probe is the product assertWindowsPiProjectionAcl with a runner that only adds timing.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner } from '../../packages/keys/src/command-runner';
import { assertWindowsPiProjectionAcl } from '../../packages/keys/src/pi-provider-launcher-core';

const arm = process.argv[2];
if (arm !== 'complete' && arm !== 'killtree') throw new Error(`unknown arm ${arm}`);
const KILL_AT_MS = 29_800;
const t0 = Date.now();
const log = (msg: string): void => console.log(`[e5] arm=${arm} t+${Date.now() - t0}ms utc=${new Date().toISOString()} ${msg}`);

function listProcessTable(label: string): Promise<void> {
  const started = Date.now();
  const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='conhost.exe'\" | "
    + "ForEach-Object { '{0} pid={1} ppid={2} created={3} userMs={4} kernelMs={5}' -f $_.Name,$_.ProcessId,$_.ParentProcessId,"
    + "($(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { 'n/a' })),"
    + "[math]::Round($_.UserModeTime/10000),[math]::Round($_.KernelModeTime/10000) }";
  return new Promise(resolve => {
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8_000 }, (error, stdout) => {
      log(`[e2] label=${label} listElapsed=${Date.now() - started}ms error=${error ? error.message.split('\n')[0] : 'none'}\n${String(stdout).trim()}`);
      resolve();
    });
  });
}

function timedRunner(label: string, killAtMs?: number): CommandRunner {
  return (executable, args, stdin) => new Promise(resolve => {
    const started = Date.now();
    const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`probe=${label} spawned pid=${child.pid}`);
    let stdout = ''; let stderr = ''; let firstOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { if (!firstOut) { firstOut = true; log(`probe=${label} first-stdout t=${Date.now() - started}ms`); } stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; log(`probe=${label} stderr t=${Date.now() - started}ms ${c.trim().replace(/\r?\n/gu, ' | ')}`); });
    let timer: NodeJS.Timeout | undefined;
    if (killAtMs !== undefined) {
      timer = setTimeout(() => {
        log(`probe=${label} KILLTREE at t=${Date.now() - started}ms pid=${child.pid}`);
        try { log(`taskkill: ${execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { encoding: 'utf8' }).trim()}`); }
        catch (error) { log(`taskkill failed: ${(error as Error).message.split('\n')[0]}`); }
        void listProcessTable(`${label}-after-killtree`);
      }, killAtMs);
    }
    child.on('error', () => { if (timer) clearTimeout(timer); resolve({ exitCode: 127, stderr: 'command unavailable', stdout: '' }); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      log(`probe=${label} close t=${Date.now() - started}ms code=${code} signal=${signal}`);
      resolve({ exitCode: code ?? 1, stderr, stdout });
    });
    child.stdin.end(stdin);
  });
}

async function probe(label: string, directory: string, killAtMs?: number): Promise<void> {
  const started = Date.now();
  try {
    await assertWindowsPiProjectionAcl(directory, { run: timedRunner(label, killAtMs) });
    log(`probe=${label} RESULT=accepted elapsed=${Date.now() - started}ms`);
  } catch (error) {
    log(`probe=${label} RESULT=rejected elapsed=${Date.now() - started}ms ${(error as Error).message}`);
  }
}

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-e5-')));
execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`,
  '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
await listProcessTable('before-cold');
await probe('cold', directory, arm === 'killtree' ? KILL_AT_MS : undefined);
await listProcessTable('after-cold');
for (let i = 1; i <= 3; i++) await probe(`warm${i}`, directory);
await listProcessTable('after-warm');
await fs.rm(directory, { recursive: true, force: true });
