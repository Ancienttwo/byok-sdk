import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readServiceInstallationRecord,
  serviceInstallationOver,
  ServiceInstallationError,
  SERVICE_PAYLOAD_MANIFEST,
  type ServiceInstallation,
} from '../lifecycle/service-installation';
import { createManagedLifecycle, type ManagedServiceLifecycle, type PlatformUnit } from '../lifecycle/managed-lifecycle';
import { SERVICE_UNIT_MARKER, withServiceOwnerGate } from '../lifecycle/service-unit';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

useInProcessServiceLifecycleGate();

/** Prints the verdicts in `<root>/verdicts.json` the way `upgrade check --store --json` does. */
const PRECHECK = [
  "const fs = require('node:fs');",
  'const stores = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
  'console.log(JSON.stringify({ version: "x", stores }));',
  "process.exit(stores.some((s) => s.verdict === 'new-path-repair' || s.verdict === 'rejected') ? 2 : 0);",
].join('\n');

let root: string;
let storeDir: string;
let installRoot: string;
let db: string;
let events: string[];
let unhealthy: Set<string>;
let onHealth: (version: string) => Promise<void>;
let installation: ServiceInstallation;

function fakeLifecycle(): ManagedServiceLifecycle {
  const record = (event: string) => async () => { events.push(event); };
  return {
    install: record('install'), uninstall: record('uninstall'), start: record('start'), stop: record('stop'),
    owned: (operation) => withServiceOwnerGate(() => operation({ install: record('install'), uninstall: record('uninstall') })),
    repair: async () => ({ status: 'not-needed', state: 'exact' }),
    inspect: async () => ({ state: 'exact', unitPath: 'unit', launcherPath: 'launcher' }),
    status: async () => { throw new Error('not used'); },
  };
}

async function payload(id: string, files: Record<string, string> = {}, extra: Record<string, string> = {}): Promise<string> {
  const dir = path.join(root, 'payloads', id);
  const all = { 'host.js': `// ${id}`, 'precheck.cjs': PRECHECK, ...files };
  for (const [name, content] of Object.entries({ ...all, ...extra })) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  const digests = Object.fromEntries(Object.entries(all).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]));
  await fs.writeFile(path.join(dir, SERVICE_PAYLOAD_MANIFEST), JSON.stringify({ format: 'byok-service-payload', version: 1, id, files: digests }));
  return dir;
}

async function verdicts(verdict: string): Promise<void> {
  await fs.writeFile(path.join(root, 'verdicts.json'), JSON.stringify([
    { store: 'client-journal', path: db, verdict, reason: verdict },
  ]));
}

async function pointer(name: string): Promise<string | undefined> {
  return fs.readlink(path.join(installRoot, name)).then((target) => path.basename(target), () => undefined);
}

/** Throws EIO from the `step`-th fs.rename (1-based) and lets every other rename through. */
function failRename(step: number | ((destination: string) => boolean)): { fired: () => boolean; restore: () => void } {
  const original = fs.rename.bind(fs);
  let calls = 0;
  let fired = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    calls += 1;
    if (!fired && (typeof step === 'number' ? calls === step : step(String(to)))) {
      fired = true;
      throw Object.assign(new Error(`injected rename I/O failure: ${String(to)}`), { code: 'EIO' });
    }
    return original(from, to);
  });
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

/**
 * A real managed lifecycle for owner `cli` over this store, with `app`
 * recorded as the store's lifecycle owner and an exact marked unit.
 */
async function cliOverAppOwner(installRootFor = installRoot): Promise<ServiceInstallation> {
  await fs.mkdir(path.join(storeDir, 'service'), { recursive: true });
  await fs.writeFile(path.join(storeDir, 'service', 'lifecycle-owner.json'), JSON.stringify({ version: 1, owner: 'app', service: 'svc' }));
  const unitPath = path.join(root, 'unit');
  await fs.writeFile(unitPath, SERVICE_UNIT_MARKER);
  const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'logs'), owner: 'cli', program: { command: process.execPath, args: [] } };
  const unit: PlatformUnit = {
    serviceName: 'svc', unitPath, launcherPath: unitPath,
    files: () => [{ path: unitPath, content: SERVICE_UNIT_MARKER }],
    activate: async () => undefined, deactivate: async () => undefined, removeFiles: async () => undefined,
    start: async () => undefined, stop: async () => undefined,
    query: async () => ({ running: true, determinate: true, detail: 'fake' }),
  };
  return serviceInstallationOver({
    service: def,
    productId: 'svc',
    installRoot: installRootFor,
    program: () => def.program,
    precheck: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] }),
    healthCheck: async () => undefined,
  }, createManagedLifecycle(def, unit));
}

/** Every file's bytes and every link's target under `dir`. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, file);
    if (entry.isSymbolicLink()) out[key] = `-> ${await fs.readlink(file)}`;
    else if (entry.isFile()) out[key] = (await fs.readFile(file)).toString('base64');
    else out[key] = 'dir';
  }
  return out;
}

/** A state recover() leaves: nothing pending, and the store holds the data of the version `current` runs. */
async function expectConsistent(dataOf: Record<string, string>): Promise<void> {
  expect((await installation.receipt())?.state).not.toBe('pending');
  const current = (await pointer('current'))!;
  expect(await fs.readFile(db, 'utf8')).toBe(dataOf[current]);
}

/** The installation over `lifecycle`, with this suite's health seam. */
function installationOver(lifecycle: ManagedServiceLifecycle): ServiceInstallation {
  return serviceInstallationOver({
    service: { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app' },
    productId: 'svc',
    installRoot,
    program: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'host.js')] }),
    precheck: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] }),
    healthCheck: async () => {
      const version = (await installation.currentVersion())!;
      events.push(`health ${version}`);
      await onHealth(version);
      if (unhealthy.has(version)) throw new Error('unhealthy');
    },
    healthTimeoutMs: 5_000,
    stopTimeoutMs: 2_000,
  }, lifecycle);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-install-')));
  storeDir = path.join(root, 'store');
  installRoot = path.join(root, 'app');
  db = path.join(storeDir, 'daemon.db');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(db, 'v1 data');
  await fs.writeFile(`${db}-wal`, 'v1 wal');
  await verdicts('accepted');
  events = [];
  unhealthy = new Set();
  onHealth = async () => undefined;
  installation = installationOver(fakeLifecycle());
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createServiceInstallation (#1097 slice 2)', () => {
  it('install stages the payload, points current at it and records the install root', async () => {
    await installation.install(await payload('1.0.0'));
    expect(await pointer('current')).toBe('1.0.0');
    expect(await fs.readFile(path.join(installRoot, 'versions', '1.0.0', 'host.js'), 'utf8')).toBe('// 1.0.0');
    expect(await readServiceInstallationRecord(storeDir)).toEqual({ format: 'byok-service-installation', version: 1, installRoot });
    expect(events).toEqual(['install']);
    // Installing the same payload again only reinstalls the unit; another version must be upgraded.
    await installation.install(await payload('1.0.0'));
    await expect(installation.install(await payload('2.0.0'))).rejects.toMatchObject({ code: 'installation_exists' });
  });

  it('refuses a payload whose files do not match its manifest', async () => {
    await expect(installation.install(await payload('1.0.0', {}, { 'unlisted.js': 'x' }))).rejects.toMatchObject({ code: 'payload_invalid' });
    const tampered = await payload('1.0.1');
    await fs.writeFile(path.join(tampered, 'host.js'), 'tampered');
    await expect(installation.install(tampered)).rejects.toMatchObject({ code: 'payload_invalid' });
    expect(await pointer('current')).toBeUndefined();
  });

  it('upgrade stops, prechecks, snapshots, switches and confirms health', async () => {
    await installation.install(await payload('1.0.0'));
    events = [];
    const receipt = await installation.upgrade(await payload('2.0.0'));
    expect(receipt).toMatchObject({ state: 'switched', from: '1.0.0', to: '2.0.0' });
    expect(events).toEqual(['stop', 'start', 'health 2.0.0']);
    expect([await pointer('current'), await pointer('previous')]).toEqual(['2.0.0', '1.0.0']);
    expect(await installation.receipt()).toEqual(receipt);

    // A third version prunes the oldest; current and previous stay.
    await installation.upgrade(await payload('3.0.0'));
    expect((await fs.readdir(path.join(installRoot, 'versions'))).sort()).toEqual(['2.0.0', '3.0.0']);
    expect(await fs.readdir(path.join(installRoot, 'snapshots'))).toEqual(['3.0.0']);
  });

  it('stops before the switch when the candidate needs a new store path, and restarts the old version', async () => {
    await installation.install(await payload('1.0.0'));
    await verdicts('new-path-repair');
    events = [];
    const error = await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceInstallationError);
    expect(error).toMatchObject({ code: 'store_repair_required', stores: [{ verdict: 'new-path-repair', path: db }] });
    expect(events).toEqual(['stop', 'start']);
    expect(await pointer('current')).toBe('1.0.0');
    expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_repair_required', from: '1.0.0', to: '2.0.0' });
  });

  it('a candidate whose precheck gives no verdict is not switched to', async () => {
    await installation.install(await payload('1.0.0'));
    await fs.writeFile(path.join(root, 'verdicts.json'), 'not json');
    await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'precheck_failed' });
    expect(await pointer('current')).toBe('1.0.0');
  });

  it('a failed health check restores the old version and its store snapshot together', async () => {
    await installation.install(await payload('1.0.0'));
    unhealthy.add('2.0.0');
    // The candidate rewrites the store and adds a journal before it fails.
    onHealth = async (version) => {
      if (version !== '2.0.0') return;
      await fs.writeFile(db, 'v2 data');
      await fs.rm(`${db}-wal`);
      await fs.writeFile(`${db}-journal`, 'v2 journal');
    };
    events = [];
    await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
    expect(events).toEqual(['stop', 'start', 'health 2.0.0', 'stop', 'start', 'health 1.0.0']);
    expect(await pointer('current')).toBe('1.0.0');
    expect(await pointer('previous')).toBeUndefined();
    expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');
    await expect(fs.access(`${db}-journal`)).rejects.toThrow();
    expect(await installation.receipt()).toMatchObject({ state: 'rolled-back', code: 'health_check_failed', from: '1.0.0', to: '2.0.0' });
  });

  it('reports rollback_unhealthy when the restored version fails too', async () => {
    await installation.install(await payload('1.0.0'));
    unhealthy.add('2.0.0');
    unhealthy.add('1.0.0');
    await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'rollback_unhealthy' });
    expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'rollback_unhealthy' });
  });

  it('rollback restores previous and the snapshot once', async () => {
    await installation.install(await payload('1.0.0'));
    await installation.upgrade(await payload('2.0.0'));
    await fs.writeFile(db, 'v2 data');
    const receipt = await installation.rollback();
    expect(receipt).toMatchObject({ state: 'rolled-back', from: '1.0.0', to: '2.0.0' });
    expect(receipt.code).toBeUndefined();
    expect(await pointer('current')).toBe('1.0.0');
    expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    await expect(installation.rollback()).rejects.toMatchObject({ code: 'no_rollback' });
  });

  it('a failed upgrade keeps the earlier upgrade rollbackable: rollback then restores the version before it', async () => {
    await installation.install(await payload('1.0.0'));
    await installation.upgrade(await payload('2.0.0'));
    await fs.writeFile(db, 'v2 data');
    unhealthy.add('3.0.0');
    onHealth = async (version) => { if (version === '3.0.0') await fs.writeFile(db, 'v3 data'); };
    await expect(installation.upgrade(await payload('3.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
    expect(await installation.receipt()).toMatchObject({ state: 'rolled-back', from: '2.0.0', to: '3.0.0', previous: '1.0.0' });
    expect([await pointer('current'), await pointer('previous')]).toEqual(['2.0.0', '1.0.0']);
    expect(await fs.readFile(db, 'utf8')).toBe('v2 data');
    // The rollback goes to 1.0.0 with the snapshot taken when 2.0.0 was switched to.
    expect(await installation.rollback()).toMatchObject({ state: 'rolled-back', from: '1.0.0', to: '2.0.0' });
    expect([await pointer('current'), await pointer('previous')]).toEqual(['1.0.0', undefined]);
    expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');
  });

  it('recover completes an interrupted switch deterministically: a crash between the two junction renames', async () => {
    await installation.install(await payload('1.0.0'));
    await installation.upgrade(await payload('2.0.0'));
    // The state a crash leaves mid-switch to 2.0.0 on Windows: `current` moved
    // aside, the new pointer not yet renamed in, the store already written.
    await fs.writeFile(path.join(installRoot, 'upgrade-receipt.json'), JSON.stringify({
      format: 'byok-service-upgrade-receipt', version: 1, state: 'pending', from: '1.0.0', to: '2.0.0', at: new Date().toISOString(),
    }));
    await fs.rename(path.join(installRoot, 'current'), path.join(installRoot, 'current.old'));
    await fs.symlink(path.join('versions', '2.0.0'), path.join(installRoot, 'current.next'));
    await fs.writeFile(db, 'half-written');

    await expect(installation.upgrade(await payload('3.0.0'))).rejects.toMatchObject({ code: 'upgrade_pending' });
    events = [];
    const receipt = await installation.recover();
    expect(receipt).toMatchObject({ state: 'rolled-back', code: 'upgrade_pending', from: '1.0.0', to: '2.0.0' });
    expect(events).toEqual(['stop', 'start', 'health 1.0.0']);
    expect(await pointer('current')).toBe('1.0.0');
    const residue = (await fs.readdir(installRoot)).filter((name) => name.endsWith('.old') || name.endsWith('.next'));
    expect(residue).toEqual([]);
    expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    // Nothing pending is left: recover is a no-op that returns the receipt.
    expect(await installation.recover()).toEqual(receipt);
  });

  it('recovers a death between the stop intent and the stop: recover() restarts the known-good version', async () => {
    await installation.install(await payload('1.0.0'));
    await installation.upgrade(await payload('2.0.0'));
    await fs.writeFile(db, 'v2 data');
    // The process dies at the stop: the intent was already written, the
    // service was stopped, and the normal failure path's restart died too.
    const killed = new Error('process killed');
    const base = fakeLifecycle();
    const dying: ManagedServiceLifecycle = {
      ...base,
      stop: async () => { events.push('stop'); throw killed; },
      start: async () => { events.push('start'); throw killed; },
    };
    const doomed = installationOver(dying);
    await expect(doomed.upgrade(await payload('3.0.0'))).rejects.toThrow('process killed');
    expect(await doomed.receipt()).toMatchObject({ state: 'pending', from: '2.0.0', to: '3.0.0' });
    expect(await pointer('current')).toBe('2.0.0');
    expect(await fs.readFile(db, 'utf8')).toBe('v2 data');

    events = [];
    const receipt = await installation.recover();
    expect(receipt).toMatchObject({ state: 'rolled-back', code: 'upgrade_pending', from: '2.0.0', to: '3.0.0' });
    expect(events).toEqual(['stop', 'start', 'health 2.0.0']);
    expect(await pointer('current')).toBe('2.0.0');
    expect(await fs.readFile(db, 'utf8')).toBe('v2 data');
  });

  it('refuses the running version and a different payload under a staged id', async () => {
    await installation.install(await payload('1.0.0'));
    await expect(installation.upgrade(await payload('1.0.0'))).rejects.toMatchObject({ code: 'version_current' });
    await installation.upgrade(await payload('2.0.0'));
    await installation.rollback();
    await expect(installation.upgrade(await payload('2.0.0', { 'host.js': 'other' }))).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('uninstall removes the versions, pointers, snapshots, receipt and record, and leaves the store', async () => {
    await installation.install(await payload('1.0.0'));
    await installation.upgrade(await payload('2.0.0'));
    await installation.uninstall();
    expect(await fs.readdir(installRoot)).toEqual([]);
    expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
    expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    expect(events.at(-1)).toBe('uninstall');
  });
  describe('crash consistency: every rename may fail, and recover() resolves what it leaves', () => {
    it('recovery survives an interrupted restore receipt commit', async () => {
      await installation.install(await payload('1.0.0'));
      unhealthy.add('2.0.0');
      let fault = false;
      const injected = failRename((to) => fault && to === path.join(installRoot, 'upgrade-receipt.json'));
      onHealth = async (version) => { if (version === '1.0.0') fault = true; };
      try { await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'EIO' }); }
      finally { injected.restore(); }
      onHealth = async () => undefined;
      expect(await installation.receipt()).toMatchObject({ state: 'pending', from: '1.0.0', to: '2.0.0' });
      await expect(installation.recover()).resolves.toMatchObject({ state: 'rolled-back' });
    });

    it('rollback journals an interrupted pointer switch', async () => {
      await installation.install(await payload('1.0.0'));
      await installation.upgrade(await payload('2.0.0'));
      await fs.writeFile(db, 'v2 data');
      const injected = failRename((to) => to === path.join(installRoot, 'current'));
      try { await expect(installation.rollback()).rejects.toMatchObject({ code: 'EIO' }); }
      finally { injected.restore(); }
      expect(await installation.receipt()).toMatchObject({ state: 'pending', from: '1.0.0', to: '2.0.0' });
      await expect(installation.recover()).resolves.toMatchObject({ state: 'rolled-back', from: '1.0.0', to: '2.0.0' });
      expect(await pointer('current')).toBe('1.0.0');
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it('install and uninstall refuse a pending receipt and change nothing', async () => {
      await installation.install(await payload('1.0.0'));
      await installation.upgrade(await payload('2.0.0'));
      await fs.writeFile(path.join(installRoot, 'upgrade-receipt.json'), JSON.stringify({
        format: 'byok-service-upgrade-receipt', version: 1, state: 'pending', from: '1.0.0', to: '2.0.0', at: new Date().toISOString(),
      }));
      const reinstall = await payload('2.0.0');
      const before = await tree(root);
      events = [];
      await expect(installation.install(reinstall)).rejects.toMatchObject({ code: 'upgrade_pending' });
      await expect(installation.uninstall()).rejects.toMatchObject({ code: 'upgrade_pending' });
      expect(events).toEqual([]);
      expect(await tree(root)).toEqual(before);
    });

    it('rollback: an EIO at each rename, then recover', async () => {
      for (let step = 1; ; step += 1) {
        await fs.rm(installRoot, { recursive: true, force: true });
        await fs.writeFile(db, 'v1 data');
        await installation.install(await payload('1.0.0'));
        await installation.upgrade(await payload('2.0.0'));
        await fs.writeFile(db, 'v2 data');
        const injected = failRename(step);
        try { await installation.rollback().catch((error: unknown) => { expect(error).toMatchObject({ code: 'EIO' }); }); }
        finally { injected.restore(); }
        if (!injected.fired()) {
          expect(step).toBeGreaterThan(3);
          break;
        }
        await installation.recover();
        await expectConsistent({ '1.0.0': 'v1 data', '2.0.0': 'v2 data' });
        // Only an EIO before the pending receipt is written leaves 2.0.0; every later one is completed.
        expect(await pointer('current')).toBe(step === 1 ? '2.0.0' : '1.0.0');
      }
    });

    it('a failed health check: an EIO at each rename, then recover', async () => {
      unhealthy.add('2.0.0');
      onHealth = async (version) => { if (version === '2.0.0') await fs.writeFile(db, 'v2 data'); };
      for (let step = 1; ; step += 1) {
        await fs.rm(installRoot, { recursive: true, force: true });
        await fs.writeFile(db, 'v1 data');
        await installation.install(await payload('1.0.0'));
        const candidate = await payload('2.0.0');
        const injected = failRename(step);
        try { await expect(installation.upgrade(candidate)).rejects.toThrow(); }
        finally { injected.restore(); }
        if (!injected.fired()) {
          expect(step).toBeGreaterThan(5);
          break;
        }
        await installation.recover();
        await expectConsistent({ '1.0.0': 'v1 data', '2.0.0': 'v2 data' });
        expect(await pointer('current')).toBe('1.0.0');
      }
    });
  });

  describe('lifecycle owner: another recorded owner is refused before anything is written', () => {
    it('a refused foreign-owner install preserves the recorded installation', async () => {
      await installation.install(await payload('1.0.0'));
      const before = await readServiceInstallationRecord(storeDir);
      const other = await cliOverAppOwner(path.join(root, 'cli-app'));
      await expect(other.install(await payload('2.0.0'))).rejects.toMatchObject({ code: 'lifecycle_owner_conflict' });
      expect(await readServiceInstallationRecord(storeDir)).toEqual(before);
    });

    it('a different owner cannot upgrade the recorded installation', async () => {
      await installation.install(await payload('1.0.0'));
      const other = await cliOverAppOwner();
      const outcome = await other.upgrade(await payload('2.0.0')).then((value) => ({ accepted: value }), (error: unknown) => ({ error }));
      expect(outcome).toMatchObject({ error: { code: 'lifecycle_owner_conflict' } });
    });

    it.each(['install', 'upgrade', 'rollback', 'recover', 'uninstall'] as const)('%s by a different owner leaves every file byte-identical', async (action) => {
      await installation.install(await payload('1.0.0'));
      await installation.upgrade(await payload('2.0.0'));
      const other = await cliOverAppOwner();
      const [first, third] = [await payload('1.0.0'), await payload('3.0.0')];
      const before = await tree(root);
      const run = {
        install: () => other.install(first),
        upgrade: () => other.upgrade(third),
        rollback: () => other.rollback(),
        recover: () => other.recover(),
        uninstall: () => other.uninstall(),
      }[action];
      await expect(run()).rejects.toMatchObject({ code: 'lifecycle_owner_conflict' });
      expect(await tree(root)).toEqual(before);
    });
  });
});
