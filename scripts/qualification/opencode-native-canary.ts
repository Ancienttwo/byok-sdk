import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function isCwdRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { phase?: unknown; retry?: unknown; message?: unknown };
  return failure.phase === 'start' && failure.retry === 'non-retryable'
    && typeof failure.message === 'string' && failure.message.includes('resumes it only there');
}

if (import.meta.main) {
const { OpenCodeAdapter } = await import('../../packages/client/dist/adapters/index.js');
const { sealRuntimeOperationManifest } = await import('../../packages/client/src/types');
const { createExecutionScratch } = await import('../../packages/client/src/daemon/retention/scratch');

const root = path.resolve(process.env.OC_CANARY_ROOT ?? '_ops/oc-canary');
mkdirSync(root, { recursive: true });
const scratchRoot = mkdtempSync(path.join(root, 'scratch-'));
const models = ['opencode/deepseek-v4.1-flash-free', 'opencode/crouton-alpha-free', 'opencode/beam-free'];
const report: any = { date: new Date().toISOString(), os: process.platform, arch: os.arch(), models,
  gates: {}, fallback: 'not provoked; replay required', calls: [], modelReadbacks: [], permissions: [] };
const children: any[] = [];
const pending = new Map<any, any>();
let session: any;
let activeGate = 'detect';
function processes() {
  if (process.platform === 'win32') {
    const value = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^opencode' } | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress"], { encoding: 'utf8' }) || '[]');
    return Array.isArray(value) ? value : [value];
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => /opencode/.test(line) && /(?:\bacp\b|serve --service)/.test(line))
    .map(line => { const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)!; return { ProcessId: +pid!, ParentProcessId: +ppid!, CommandLine: command }; });
}
const baseline = new Set(processes().map((p: any) => p.ProcessId));
function cleanupProof() {
  const leaked = processes().filter((p: any) => !baseline.has(p.ProcessId));
  const alive = children.filter(child => { try { process.kill(child.pid, 0); return true; } catch { return false; } });
  return { newRuntimeProcesses: leaked.length, liveOwnedRoots: alive.length,
    survivingServices: leaked.filter((p: any) => /serve --service/.test(p.CommandLine)).length };
}
function save() { writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
const observedSpawn: typeof spawn = ((command: any, args: any, options: any) => {
  const child = spawn(command, args, options);
  children.push(child);
  let buffer = '';
  child.stdout?.on('data', chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: any; try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'session/request_permission') { pending.set(message.id, 'permission'); report.permissions.push({ requested: true }); }
      for (const config of message.result?.configOptions ?? message.params?.update?.configOptions ?? []) {
        if (config.id === 'model') report.modelReadbacks.push(config.currentValue);
      }
      if (message.result?.outcome) report.permissions.push({ response: message.result.outcome });
      save();
    }
  });
  const originalWrite = child.stdin?.write.bind(child.stdin);
  if (child.stdin && originalWrite) child.stdin.write = ((chunk: any, ...rest: any[]) => {
    let message: any;
    try { message = JSON.parse(chunk.toString()); }
    catch { return (originalWrite as any)(chunk, ...rest); }
    if (message.method) report.calls.push({ method: message.method,
      ...(message.method === 'session/set_config_option' ? { id: message.params?.configId, value: message.params?.value } : {}) });
    if (pending.get(message.id) === 'permission') report.permissions.push({ response: message.result?.outcome });
    save();
    return (originalWrite as any)(chunk, ...rest);
  }) as any;
  return child;
}) as any;
const adapter = new OpenCodeAdapter({ models, spawnFn: observedSpawn,
  runtimeEnvironment: { base: 'allowlist' }, interruptTimeoutMs: 10000,
  ...(process.env.OC_EXECUTABLE ? { resolveBin: () => ({ command: process.env.OC_EXECUTABLE!, source: 'env' as const }) } : {}) });
async function start(instruction: string, cwd: string, sessionRef?: string) {
  mkdirSync(cwd, { recursive: true });
  const prepared = await adapter.prepare({ offer: { instruction, ...(sessionRef ? { sessionRef } : {}) }, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  const scratch = await createExecutionScratch({ root: scratchRoot });
  const env = (await adapter.runtimeEnvironment()).env;
  const manifest = sealRuntimeOperationManifest({ taskId: 'native-canary', runtimeId: 'opencode', descriptor: adapter.descriptor,
    requiredToolsetIds: [], ...(sessionRef ? { sessionRef } : {}), cwd,
    workspace: { workspaceDir: cwd }, forwardedEnvironmentNames: Object.keys(env).sort() });
  try { return await prepared.operation.start({ kind: 'instruction', instruction, manifest, scratch, env, mcpEnv: {} }); }
  catch (error) { await scratch.release(); throw error; }
}
async function collect(current: any) {
  const events: any[] = []; for await (const event of current.events) events.push(event);
  return events;
}
async function gate(name: string, run: () => Promise<void>) {
  activeGate = name;
  await run(); report.gates[name] = 'pass'; save(); console.log(name + ': pass');
}
const watchdog = setTimeout(() => {
  report.gates[activeGate] = 'timeout'; report.cleanupAtTimeout = cleanupProof(); save();
  for (const child of children) child.kill('SIGTERM');
  console.error('native canary timed out'); process.exit(2);
}, 180000);
try {
  await gate('detect', async () => {
    const detected = await adapter.detect();
    if (detected.kind !== 'available') throw new Error('native detection refused: ' + detected.kind);
    report.version = detected.version; report.rawVersion = detected.rawVersion?.trim(); report.executableSource = detected.executableSource;
    report.executable = path.basename(detected.executablePath ?? 'opencode');
  });
  const cwd = path.join(root, 'workspace');
  let ref: string;
  await gate('open_model_prompt_completion', async () => {
    session = await start('Reply with exactly OC_CANARY_OK. Do not use tools.', cwd);
    ref = session.sessionRef;
    const events = await collect(session);
    report.firstEventTypes = events.map(e => e.type);
    report.firstText = events.filter(e => e.type === 'progress').map(e => e.text).join('');
    if (!report.modelReadbacks.includes(models[0])) throw new Error('missing native selected-model readback');
    if (!report.firstText.includes('OC_CANARY_OK') || events.at(-1)?.type !== 'turn_end') throw new Error('first completion missing');
    await session.close(); session = undefined;
    report.afterCompletion = cleanupProof();
    if (Object.values(report.afterCompletion).some(n => n !== 0)) throw new Error('completion leaked native process');
  });
  await gate('resume', async () => {
    session = await start('Reply with exactly OC_RESUME_OK. Do not use tools.', cwd, ref!);
    if (session.sessionRef !== ref!) throw new Error('native session changed');
    const events = await collect(session);
    if (!events.some(e => e.type === 'progress' && e.text.includes('OC_RESUME_OK'))) throw new Error('resume completion missing');
    await session.close(); session = undefined;
  });
  await gate('cwd_refusal', async () => {
    try { session = await start('Do not run.', path.join(root, 'other'), ref!); }
    catch (error: any) {
      if (!isCwdRefusal(error)) throw error;
      report.cwdRefusal = { phase: error.phase, retry: error.retry, reason: String(error.message).replaceAll(root, '<canary>').replaceAll(os.homedir(), '<home>') }; return;
    }
    throw new Error('different cwd accepted');
  });
  try { await gate('permission_refusal', async () => {
    session = await start('Use the bash tool to run exactly: printf OC_PERMISSION_TEST. Do not run other commands. If permission is denied, stop.', cwd);
    await collect(session); await session.close(); session = undefined;
    if (!report.permissions.some((p: any) => p.response?.outcome === 'cancelled')) throw new Error('no native cancelled permission observed');
  }); } catch (error: any) {
    await session?.close(); session = undefined;
    report.gates.permission_refusal = 'fail'; report.permissionFailure = error.message; save();
    console.error('permission_refusal: fail', error.message);
  }
  await gate('cancel_cleanup', async () => {
    session = await start('Use the bash tool to run sleep 60, then reply done.', cwd);
    await session.interrupt(); await session.close(); session = undefined;
    report.afterCancel = cleanupProof();
    if (Object.values(report.afterCancel).some(n => n !== 0)) throw new Error('cancel leaked native process');
  });
  await gate('disposal', async () => {
    session = await start('Use the bash tool to run sleep 60, then reply done.', cwd);
    await session.close(); await session.close(); session = undefined;
    report.afterDisposal = cleanupProof();
    if (Object.values(report.afterDisposal).some(n => n !== 0)) throw new Error('disposal leaked native process');
  });
  report.result = report.gates.permission_refusal === 'fail' ? 'unqualified' : 'pass';
  if (report.result !== 'pass') process.exitCode = 1;
} catch (error: any) {
  report.gates[activeGate] = 'fail'; report.result = 'unqualified';
  report.failure = { name: error.name, phase: error.phase, retry: error.retry,
    message: String(error.message).replaceAll(root, '<canary>').replaceAll(os.homedir(), '<home>') };
  console.error(activeGate + ': fail', report.failure);
  process.exitCode = 1;
} finally {
  try { await session?.close(); } catch (error: any) { report.disposalError = error.name; process.exitCode = 1; }
  clearTimeout(watchdog); report.finalCleanup = cleanupProof(); save();
}
}
