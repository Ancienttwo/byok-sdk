import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { SqliteProviderProfileStore, parseModelProviderProfile, exactProviderProfileBinding } from '../../../keys/src/index';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { hermesGatewayPipeName, identifyHermesGateway } from '../adapters/hermes/gateway-identity';
import { exchangeHermesPipe, windowsLower } from '../adapters/hermes/gateway-pipe-win32';
import { ownsHermesGatewayPid } from '../adapters/hermes/gateway-ownership';
import { hermesVersionToken, QUALIFIED_HERMES_VERSION } from '../adapters/hermes/hermes-version';
import { loadKoffi } from '../adapters/win32-job-object';
import { testRuntimeEnv } from './fixtures/runtime-env';
import type { MessageDraftDelta, Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { startFakeModelEndpoint } from './fixtures/hermes-fake-model';

/**
 * #608: the adapter against a real Hermes, with a local fake model endpoint,
 * so no paid call is made. It runs only when `BYOK_HERMES_REAL_BIN` names the
 * Hermes executable (the CI job installs the qualified build on Windows).
 */
const realBin = process.env.BYOK_HERMES_REAL_BIN ?? '';
const windows = process.platform === 'win32';
const keysEntry = fileURLToPath(new URL('../../../keys/dist/index.js', import.meta.url));
const fakeKey = 'fake-real-hermes-custody-key';
const reply = 'byok-real-hermes-ok';
const IDENTIFY = `${JSON.stringify({ protocol: 1, id: 1, verb: 'identify' })}\n`;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

// The root holds the Python environment Hermes built (hundreds of MB): its removal takes a while on Windows.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
}, 600_000);

/** Output of a Hermes command with `home` as HERMES_HOME, for a failure message. */
function hermesDiagnostic(home: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(realBin, args, { encoding: 'utf8', env: { ...process.env, HERMES_HOME: home }, timeout: 600_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(JSON.stringify({ args, error: error?.message, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }));
    });
  });
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every file below `dir` whose bytes contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await fs.readFile(file).catch(() => undefined);
    if (bytes?.includes(needle)) found.push(file);
  }
  return found;
}

describe.runIf(realBin !== '')('HermesAdapter with a real Hermes and a fake model endpoint', () => {
  it('detects, prepares and runs one custody turn through the owned gateway, and leaves the key only in Hermes', async () => {
    expect(path.isAbsolute(realBin)).toBe(true);
    // Short POSIX path for the gateway's Unix socket; Windows uses a named pipe.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'bhr-')));
    dirs.push(dir);
    const workspaceDir = path.join(dir, 'workspace');
    await fs.mkdir(workspaceDir);
    const endpoint = await startFakeModelEndpoint('fake-model', reply);
    cleanups.push(endpoint.close);

    const profile = parseModelProviderProfile({ created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', adapter: 'openai_compatible', auth_mode: 'bearer', base_url: endpoint.baseUrl, capabilities: [], display_name: 'Fake local', enabled: true, kind: 'model', model: 'fake-model', profile_ref: 'custom', provider_kind: 'custom' });
    const profileDbPath = path.join(dir, 'profiles.sqlite');
    const store = new SqliteProviderProfileStore({ path: profileDbPath });
    await store.save(profile);
    await store.close();
    const binding = exactProviderProfileBinding(profile, []);
    const receipt = path.join(dir, 'custody.jsonl');
    const launcher = path.join(dir, 'launcher.mjs');
    await fs.writeFile(launcher, `import { appendFileSync } from 'node:fs';
import { parseHermesProviderLauncherRequest, runHermesProviderLauncher } from ${JSON.stringify(pathToFileURL(keysEntry).href)};
const request = parseHermesProviderLauncherRequest(process.argv.slice(2));
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({role:request.launch?.role??'admission',pid:process.pid,home:request.launch?.home})+'\\n');
const store={providerLabel:'test-only',available:async()=>true,get:async(name)=>{if(name!=='model-custom-api-key')throw Error('unexpected lookup');return ${JSON.stringify(fakeKey)}},has:async()=>true,set:async()=>{},delete:async()=>false,scope(){return this}};
try { await runHermesProviderLauncher(request,{createSecretStore:()=>store}); } catch (error) { process.stderr.write('Custody rejected: '+(error?.message??error)+'\\n'); process.exitCode=1; }
`);
    const root = path.join(dir, 'home');
    const adapter = new HermesAdapter({
      home: root,
      resolveBin: () => ({ command: realBin, source: 'env' }),
      byokLauncher: { command: process.execPath, args: [launcher], profileDbPath, selectProfile: () => binding },
      // The first detect() builds Hermes's Python environment in the new root.
      probeTimeoutMs: 900_000,
      gatewayReadyTimeoutMs: 180_000,
    });
    const timings: Record<string, number> = {};
    const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try { return await run(); } finally { timings[label] = Math.round(performance.now() - started); }
    };

    const detected = await timed('detectMs', () => adapter.detect());
    if (detected.kind !== 'available') expect.fail(`detect: ${JSON.stringify(detected)} after ${timings.detectMs} ms; ${await hermesDiagnostic(root, ['--version'])} ${await hermesDiagnostic(root, ['acp', '--check'])}`);
    const version = detected.kind === 'available' ? detected.version ?? '' : '';

    // The environment the daemon gives a task; custody narrows it to the allowlist.
    const env = testRuntimeEnv();
    expect(Object.values(env)).not.toContain(fakeKey);
    const session: Session = await timed('startMs', () => startPreparedOperation(adapter, { instruction: 'Reply with one word.' }, { workspaceDir, env }));
    const closeSession = () => session.close();
    cleanups.push(closeSession);
    const events: Array<AgentEvent | MessageDraftDelta> = [];
    await timed('turnMs', async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === 'turn_end') return;
      }
    });
    const summary = () => JSON.stringify({ version, timings, requests: endpoint.requests, events: events.map((event) => event.type) });
    expect(events.map((event) => event.type), summary()).toContain('turn_end');
    expect(events.flatMap((event) => event.type === 'progress' ? [event.text] : []).join(''), summary()).toContain(reply);

    // The key reached the Hermes child that called the model. Hermes also probes the endpoint for model
    // metadata (`/v1/models/<id>`, `/api/show`); every request that carries a credential carries this key.
    const completions = endpoint.requests.filter((request) => request.method === 'POST' && request.path === '/v1/chat/completions');
    expect(completions.length, summary()).toBeGreaterThan(0);
    for (const request of completions) expect(request.authorization, summary()).toBe(`Bearer ${fakeKey}`);
    for (const request of endpoint.requests) {
      if (request.authorization !== undefined) expect(request.authorization, summary()).toBe(`Bearer ${fakeKey}`);
    }
    expect(process.env.SDK_HERMES_PROVIDER_KEY).toBeUndefined();
    expect(Object.values(process.env)).not.toContain(fakeKey);

    const rows = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; pid: number; home?: string });
    const gatewayLauncher = rows.find((row) => row.role === 'gateway');
    const viewerLauncher = rows.find((row) => row.role === 'viewer');
    expect(gatewayLauncher?.home).toBeDefined();
    expect(viewerLauncher?.home).toBe(gatewayLauncher!.home);
    const home = await fs.realpath(gatewayLauncher!.home!);
    expect(await filesContaining(home, fakeKey)).toEqual([]);
    expect(await fs.readFile(path.join(home, 'config.yaml'), 'utf8')).toContain('fake-model');

    const pids = [gatewayLauncher!.pid, viewerLauncher!.pid];
    if (windows) {
      // The kernel names the pipe server; it must run in the tree the adapter started.
      const koffi = await loadKoffi();
      const name = hermesGatewayPipeName(home, windowsLower(koffi));
      const first = await exchangeHermesPipe(name, IDENTIFY, () => false, Date.now() + 2_000, koffi);
      expect(first?.line).toBeUndefined();
      const serverPid = first!.serverPid;
      expect(await ownsHermesGatewayPid(gatewayLauncher!.pid, serverPid)).toBe(true);
      pids.push(serverPid);
      // The real Hermes pipe server reads the line, judges this identification-level client and answers.
      // The handle is synchronous: CreateFileW, the server pid, WriteFile and the first peek all run
      // before the first await, so the time of the call itself bounds how long WriteFile held the thread.
      const syncMs: number[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const started = performance.now();
        const pending = exchangeHermesPipe(name, IDENTIFY, (pid) => pid === serverPid, Date.now() + 2_000, koffi);
        syncMs.push(performance.now() - started);
        const answer = await pending;
        expect(answer?.serverPid).toBe(serverPid);
        const result = (JSON.parse(answer!.line!) as { result: { pid: number; state: string; served_profiles: Array<{ home: string }> } }).result;
        expect(result).toMatchObject({ pid: serverPid, state: 'ready' });
        expect(result.served_profiles.map((served) => served.home.toLowerCase())).toContain(home.toLowerCase());
      }
      timings.writeFileSyncMaxMs = Math.max(...syncMs);
      expect(timings.writeFileSyncMaxMs, summary()).toBeLessThan(250);
    } else {
      expect(await identifyHermesGateway(home)).toMatchObject({ pid: gatewayLauncher!.pid, state: 'ready' });
    }

    await timed('closeMs', () => session.close());
    cleanups.splice(cleanups.indexOf(closeSession), 1);
    expect(await fs.readdir(path.join(root, 'profiles'))).toEqual([]);
    for (const pid of pids) expect(alive(pid), `pid ${pid} outlived close`).toBe(false);
    console.log(`hermes real run: ${summary()}`);
    expect(hermesVersionToken(version), version).toBe(QUALIFIED_HERMES_VERSION);
  }, 20 * 60_000);
});
