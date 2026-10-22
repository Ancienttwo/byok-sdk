import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteProviderProfileStore, parseModelProviderProfile, exactProviderProfileBinding } from '../../../keys/src/index';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { fakeHermesCommand } from './fixtures/fake-hermes-command';
import type { Session } from '../types';

const dirs: string[] = [];
const sessions: Session[] = [];
const keysEntry = fileURLToPath(new URL('../../../keys/dist/index.js', import.meta.url));
const fixture = new URL('./fixtures/fake-hermes.mjs', import.meta.url).href;
const fakeKey = 'fake-custody-test-key';
const windows = process.platform === 'win32';
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup() {
  // Short POSIX path for the gateway's Unix socket; Windows uses a named pipe.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'bhc-')));
  dirs.push(dir);
  const profile = parseModelProviderProfile({ created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'http://127.0.0.1:11434/v1', capabilities: [], display_name: 'Fake local', enabled: true, kind: 'model', model: 'fake-model', profile_ref: 'custom', provider_kind: 'custom' });
  const profileDbPath = path.join(dir, 'profiles.sqlite');
  const store = new SqliteProviderProfileStore({ path: profileDbPath });
  await store.save(profile);
  await store.close();
  const binding = exactProviderProfileBinding(profile, []);
  const receipt = path.join(dir, 'receipt.jsonl');
  const custodyReceipt = path.join(dir, 'custody.jsonl');
  const launcher = path.join(dir, 'launcher.mjs');
  await fs.writeFile(launcher, `import { appendFileSync } from 'node:fs';
import { parseHermesProviderLauncherRequest, runHermesProviderLauncher } from ${JSON.stringify(pathToFileURL(keysEntry).href)};
const request = parseHermesProviderLauncherRequest(process.argv.slice(2));
appendFileSync(${JSON.stringify(custodyReceipt)}, JSON.stringify({kind:'launcher',role:request.launch?.role,pid:process.pid})+'\\n');
const store={providerLabel:'test-only',available:async()=>true,get:async(name)=>{if(name!=='model-custom-api-key')throw Error('unexpected lookup');return ${JSON.stringify(fakeKey)}},has:async()=>true,set:async()=>{},delete:async()=>false,scope(){return this}};
try { await runHermesProviderLauncher(request,{createSecretStore:()=>store}); } catch { process.stderr.write('Custody rejected\\n'); process.exitCode=1; }
`);
  const hermes = path.join(dir, 'hermes.mjs');
  await fs.writeFile(hermes, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(custodyReceipt)},JSON.stringify({kind:'hermes',role:process.argv.includes('gateway')?'gateway':process.argv.includes('acp')?'viewer':'version',pid:process.pid,ppid:process.ppid,selected:process.env.SDK_HERMES_PROVIDER_KEY===${JSON.stringify(fakeKey)},other:process.env.ANTHROPIC_API_KEY!==undefined,home:process.env.HERMES_HOME})+'\\n');
process.env.FAKE_HERMES_RECEIPT=${JSON.stringify(receipt)};
await import(${JSON.stringify(fixture)});
`, { mode: 0o755 });
  const root = path.join(dir, 'home');
  const command = fakeHermesCommand(hermes, dir);
  const adapter = new HermesAdapter({ home: root, resolveBin: () => ({ command, source: 'path' }), byokLauncher: { command: process.execPath, args: [launcher], profileDbPath, selectProfile: () => binding } });
  const read = async () => (await fs.readFile(custodyReceipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { dir, profile, profileDbPath, binding, root, adapter, read };
}

it('rejects malformed launcher arguments and conflicting static model selection', () => {
  const launcher = { command: '/usr/bin/node', profileDbPath: '/tmp/profiles.sqlite', selectProfile: () => { throw Error('not called'); } };
  expect(() => new HermesAdapter({ home: '/tmp/hermes-custody-constructor', byokLauncher: { ...launcher, args: 'ab' as unknown as string[] } })).toThrow(/launcher/);
  expect(() => new HermesAdapter({ home: '/tmp/hermes-custody-constructor', model: { provider: 'custom', model: 'm' }, byokLauncher: launcher })).toThrow(/mutually exclusive/);
});

describe('Hermes separate credential custody', () => {
  it.skipIf(windows)('preserves gateway/viewer PID and supplies only the selected fake key in child environment', async () => {
    const f = await setup();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fake-unrelated-ambient-key';
    try {
      const session = await startPreparedOperation(f.adapter, { instruction: 'hello' }, { workspaceDir: f.dir, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'fake-resource-key' } });
      sessions.push(session);
      for await (const event of session.events) if (event.type === 'turn_end') break;
      const rows = await f.read();
      for (const role of ['gateway', 'viewer']) {
        const child = rows.find(row => row.kind === 'hermes' && row.role === role);
        const launcher = rows.find(row => row.kind === 'launcher' && row.role === role);
        expect(child).toMatchObject({ selected: true, other: false, pid: launcher.pid });
        const config = await fs.readFile(path.join(child.home, 'config.yaml'), 'utf8');
        expect(config).toContain('fake-model');
        expect(config).not.toContain(fakeKey);
      }
      expect(rows.find(row => row.role === 'version')).toMatchObject({ selected: false, other: false });
      expect(process.env.SDK_HERMES_PROVIDER_KEY).toBeUndefined();
      await session.close();
      sessions.splice(sessions.indexOf(session), 1);
      expect(await fs.readdir(path.join(f.root, 'profiles'))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  // Windows has no process replacement: the launcher stays the parent, and the gateway Hermes reports runs below it.
  it.runIf(windows)('runs Hermes below the launcher on Windows with only the selected fake key in the Hermes environment', async () => {
    const f = await setup();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fake-unrelated-ambient-key';
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      const session = await startPreparedOperation(f.adapter, { instruction: 'hello' }, { workspaceDir: f.dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: 'fake-resource-key' } });
      sessions.push(session);
      for await (const event of session.events) if (event.type === 'turn_end') break;
      const rows = await f.read();
      const pids: number[] = [];
      for (const role of ['gateway', 'viewer']) {
        const child = rows.find(row => row.kind === 'hermes' && row.role === role);
        const launcher = rows.find(row => row.kind === 'launcher' && row.role === role);
        expect(child).toMatchObject({ selected: true, other: false });
        expect(child.pid).not.toBe(launcher.pid);
        pids.push(child.pid, launcher.pid);
        const config = await fs.readFile(path.join(child.home, 'config.yaml'), 'utf8');
        expect(config).toContain('fake-model');
        expect(config).not.toContain(fakeKey);
      }
      expect(rows.find(row => row.role === 'version')).toMatchObject({ selected: false, other: false });
      expect(process.env.SDK_HERMES_PROVIDER_KEY).toBeUndefined();
      await session.close();
      sessions.splice(sessions.indexOf(session), 1);
      expect(await fs.readdir(path.join(f.root, 'profiles'))).toEqual([]);
      for (const pid of pids) expect(alive(pid)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    }
  }, 30_000);

  it('rejects stale exact binding during admission without launching Hermes', async () => {
    const f = await setup();
    const store = new SqliteProviderProfileStore({ path: f.profileDbPath });
    await store.save({ ...f.profile, model: 'changed-model' });
    await store.close();
    const result = await f.adapter.prepare({ offer: { instruction: 'hello' }, descriptor: f.adapter.descriptor, requiredToolsetIds: [] });
    expect(result).toMatchObject({ kind: 'reject', retryable: false });
    expect((await f.read()).filter(row => row.kind === 'hermes' && row.role !== 'version')).toEqual([]);
  });

  it('revalidates at launch after admission and removes the failed profile', async () => {
    const f = await setup();
    const original = f.adapter.prepare.bind(f.adapter);
    f.adapter.prepare = async input => {
      const prepared = await original(input);
      expect(prepared.kind).toBe('prepared');
      const store = new SqliteProviderProfileStore({ path: f.profileDbPath });
      await store.save({ ...f.profile, model: 'changed-after-admission' });
      await store.close();
      return prepared;
    };
    await expect(startPreparedOperation(f.adapter, { instruction: 'hello' }, { workspaceDir: f.dir, env: { PATH: process.env.PATH } })).rejects.toThrow();
    expect((await f.read()).filter(row => row.kind === 'hermes' && row.role !== 'version')).toEqual([]);
    expect(await fs.readdir(path.join(f.root, 'profiles'))).toEqual([]);
  });
});
