import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readServiceInstallationRecord,
  serviceInstallationOver,
  ServiceInstallationError,
  type ServiceInstallation,
  type ServiceInstallationOptions,
} from '../lifecycle/service-installation';
import { SERVICE_PAYLOAD_MANIFEST, writeServicePayloadManifest, type ServicePayloadManifest } from '../service-payload-manifest';
import { createManagedLifecycle, type ManagedServiceLifecycle, type PlatformUnit } from '../lifecycle/managed-lifecycle';
import { SERVICE_UNIT_MARKER, withServiceOwnerGate } from '../lifecycle/service-unit';
import * as daemonOwner from '../util/daemon-owner';
import { acquireDaemonOwner } from '../util/daemon-owner';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../util/path-mutation-gate';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

useInProcessServiceLifecycleGate();

/** Prints the verdicts in `<root>/verdicts.json` the way `upgrade check --store --json` does. */
const PRECHECK = [
  "const fs = require('node:fs');",
  'const stores = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
  'console.log(JSON.stringify({ version: "x", stores }));',
  "process.exit(stores.some((s) => s.verdict === 'new-path-repair' || s.verdict === 'rejected') ? 2 : 0);",
].join('\n');

/** Rewrites the store, then sets every verdict in `<root>/verdicts.json` to the given one, as the next precheck reports it. */
const MIGRATE = [
  "const fs = require('node:fs');",
  'const [verdictsPath, db, verdict] = process.argv.slice(2);',
  "fs.writeFileSync(db, 'migrated data');",
  'const stores = JSON.parse(fs.readFileSync(verdictsPath, "utf8"));',
  'fs.writeFileSync(verdictsPath, JSON.stringify(stores.map((s) => ({ ...s, verdict }))));',
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
function installationOver(lifecycle: ManagedServiceLifecycle, extra: Partial<ServiceInstallationOptions> = {}): ServiceInstallation {
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
    ...extra,
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
    expect(events).toEqual(['install', 'start', 'health 1.0.0']);
    // A same-id reinstall must confirm health too; another version must be upgraded.
    await installation.install(await payload('1.0.0'));
    expect(events).toEqual(['install', 'start', 'health 1.0.0', 'install', 'start', 'health 1.0.0']);
    await expect(installation.install(await payload('2.0.0'))).rejects.toMatchObject({ code: 'installation_exists' });
  });

  it.each(['first install', 'same-id reinstall', 'activation failure'])('%s removes installation artifacts when startup fails, preserving stores (#1966)', async (mode) => {
    const healthError = new Error(mode === 'activation failure' ? 'service activation failed' : 'identity endpoint is unhealthy');
    const unitPath = path.join(root, 'service.unit');
    const launcherPath = path.join(root, 'launcher');
    let running = false;
    const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app', program: { command: process.execPath, args: [] } };
    const unit: PlatformUnit = {
      serviceName: 'svc', unitPath, launcherPath,
      files: () => [unitPath, launcherPath].map((file) => ({ path: file, content: SERVICE_UNIT_MARKER })),
      activate: async () => { running = true; if (mode === 'activation failure') throw healthError; },
      deactivate: async () => { running = false; },
      removeFiles: async () => { for (const file of [unitPath, launcherPath]) await fs.rm(file); },
      start: async () => { running = true; }, stop: async () => { running = false; },
      query: async () => ({ running, determinate: true, detail: 'fake' }),
    };
    installation = installationOver(createManagedLifecycle(def, unit));
    const candidate = await payload('1.0.0');
    if (mode === 'same-id reinstall') await installation.install(candidate);
    onHealth = async () => { throw healthError; };
    const hostStore = path.join(root, 'host-store.json');
    await fs.writeFile(hostStore, 'Host data');
    const daemonData = await fs.readFile(db);
    const daemonWal = await fs.readFile(`${db}-wal`);

    const error = await installation.install(candidate).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceInstallationError);
    expect(error).toMatchObject({ code: 'install_health_check_failed', cause: healthError });
    expect((error as Error).cause).toBe(healthError);
    expect(await installation.lifecycle.inspect()).toMatchObject({ state: 'absent' });
    expect(await installation.lifecycle.status()).toMatchObject({ installed: false, running: false });
    for (const file of [unitPath, launcherPath, path.join(installRoot, 'current'), path.join(storeDir, 'service', 'installation.json'), path.join(storeDir, 'service', 'lifecycle-owner.json'), path.join(installRoot, 'versions', '1.0.0')]) {
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await installation.currentVersion()).toBeUndefined();
    expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
    expect(await fs.readFile(db)).toEqual(daemonData);
    expect(await fs.readFile(`${db}-wal`)).toEqual(daemonWal);
    expect(await fs.readFile(hostStore, 'utf8')).toBe('Host data');
  });

  it.each(['ignores abort forever', 'succeeds after the deadline', 'start still in flight'])('install enforces its deadline when %s (#1966)', async (mode) => {
    const base = fakeLifecycle();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    const lifecycle = mode === 'start still in flight' ? {
      ...base,
      start: async () => { events.push('start'); entered(); await pending; },
    } : base;
    let signal: AbortSignal | undefined;
    installation = installationOver(lifecycle, {
      healthTimeoutMs: 50,
      healthCheck: async (value) => { signal = value; entered(); await pending; },
    });
    const candidate = await payload('1.0.0');
    vi.useFakeTimers();
    try {
      const installing = installation.install(candidate).catch((caught: unknown) => caught);
      await began;
      await vi.advanceTimersByTimeAsync(51);
      if (mode === 'start still in flight') {
        // Cleanup must not race a platform start that could restart after it.
        expect(events).not.toContain('uninstall');
        release();
      }
      const error = await installing;
      expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { message: 'the service health check timed out after 50 ms' } });
      expect(await installation.currentVersion()).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);
      expect(events.at(-1)).toBe('uninstall');
      if (mode !== 'start still in flight') expect(signal?.aborted).toBe(true);
      if (mode === 'succeeds after the deadline') {
        release();
        await Promise.resolve();
        expect(await installation.currentVersion()).toBeUndefined();
      }
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it.each(['current', 'installation.json'])('install removes its artifacts after a failed %s write (#1966)', async (target) => {
    const candidate = await payload('1.0.0');
    const destination = target === 'current' ? path.join(installRoot, target) : path.join(storeDir, 'service', target);
    const fault = failRename((file) => file === destination);
    try {
      const error = await installation.install(candidate).catch((caught: unknown) => caught);
      expect(fault.fired()).toBe(true);
      expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { code: 'EIO' } });
      expect(await installation.currentVersion()).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);
    } finally {
      fault.restore();
    }
  });

  it('reports an install removal failure with both errors and names the remaining artifacts (#1966)', async () => {
    const removalError = new Error('service manager refused removal');
    const base = fakeLifecycle();
    installation = installationOver({
      ...base,
      owned: (operation) => withServiceOwnerGate(() => operation({
        install: base.install,
        uninstall: async () => { throw removalError; },
      })),
    });
    unhealthy.add('1.0.0');
    const error = await installation.install(await payload('1.0.0')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceInstallationError);
    expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { errors: [expect.objectContaining({ message: 'unhealthy' }), removalError] } });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain('Remaining: service unit and launcher, current pointer, installation record, staged version directory');
    expect(await pointer('current')).toBe('1.0.0');
    expect(await readServiceInstallationRecord(storeDir)).toBeDefined();
    expect(await fs.readFile(path.join(installRoot, 'versions', '1.0.0', 'host.js'), 'utf8')).toBe('// 1.0.0');
  });

  it('refuses a payload whose files do not match its manifest', async () => {
    await expect(installation.install(await payload('1.0.0', {}, { 'unlisted.js': 'x' }))).rejects.toMatchObject({ code: 'payload_invalid' });
    const tampered = await payload('1.0.1');
    await fs.writeFile(path.join(tampered, 'host.js'), 'tampered');
    await expect(installation.install(tampered)).rejects.toMatchObject({ code: 'payload_invalid' });
    const missing = await payload('1.0.2');
    await fs.rm(path.join(missing, 'precheck.cjs'));
    await expect(installation.install(missing)).rejects.toMatchObject({ code: 'payload_invalid' });
    // A leading BOM stays invalid JSON, as it was for 0.41.0's reader.
    const bom = await payload('1.0.3');
    const manifestPath = path.join(bom, SERVICE_PAYLOAD_MANIFEST);
    await fs.writeFile(manifestPath, `\uFEFF${await fs.readFile(manifestPath, 'utf8')}`);
    await expect(installation.install(bom)).rejects.toMatchObject({ code: 'payload_invalid' });
    const parsed = JSON.parse((await fs.readFile(manifestPath, 'utf8')).slice(1)) as ServicePayloadManifest;
    await fs.writeFile(manifestPath, JSON.stringify({ ...parsed, meta: [] }));
    await expect(installation.install(bom)).rejects.toMatchObject({ code: 'payload_invalid' });
    await fs.writeFile(manifestPath, 'null');
    await expect(installation.install(bom)).rejects.toMatchObject({ code: 'payload_invalid' });
    expect(await pointer('current')).toBeUndefined();
  });

  it('writeServicePayloadManifest writes a manifest stage accepts, with meta, and refuses what it cannot list (#1842)', async () => {
    const dir = path.join(root, 'built');
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(dir, 'precheck.cjs'), PRECHECK);
    await fs.writeFile(path.join(dir, 'host.js'), '// built');
    await fs.writeFile(path.join(dir, 'lib', 'b.js'), 'b');
    await fs.writeFile(path.join(dir, '9'), '9');
    await fs.writeFile(path.join(dir, '10'), '10');
    await expect(writeServicePayloadManifest(dir, { id: '../x' })).rejects.toThrow('Invalid payload id');
    await expect(writeServicePayloadManifest(dir, { id: '1.0.0', meta: [] as never })).rejects.toThrow('JSON object');
    const bytes = await writeServicePayloadManifest(dir, { id: '1.0.0', meta: { node: '>=22' } });
    expect(await fs.readFile(path.join(dir, SERVICE_PAYLOAD_MANIFEST))).toEqual(Buffer.from(bytes));
    const text = new TextDecoder().decode(bytes);
    const written = JSON.parse(text) as ServicePayloadManifest;
    expect(Object.keys(written)).toEqual(['format', 'version', 'id', 'files', 'meta']);
    // By code unit, so "10" precedes "9" even though object key order would put integer-like keys first.
    const order = ['10', '9', 'host.js', 'lib/b.js', 'precheck.cjs'].map((name) => text.indexOf(`"${name}":`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
    await expect(writeServicePayloadManifest(dir, { id: '1.0.0' })).rejects.toThrow('already exists');

    const seen: ServicePayloadManifest[] = [];
    installation = installationOver(fakeLifecycle(), { verifyPayload: (_dir, manifest) => { seen.push(manifest); } });
    await installation.install(dir);
    expect(seen[0]?.meta).toEqual({ node: '>=22' });
    expect(Object.isFrozen(seen[0]?.files)).toBe(true);
    expect(await fs.readFile(path.join(installRoot, 'versions', '1.0.0', SERVICE_PAYLOAD_MANIFEST))).toEqual(Buffer.from(bytes));

    const empty = path.join(root, 'empty');
    await fs.mkdir(empty);
    await expect(writeServicePayloadManifest(empty, { id: '1.0.0' })).rejects.toThrow('has no files');
    await fs.symlink(path.join(dir, 'host.js'), path.join(empty, 'link.js'));
    await expect(writeServicePayloadManifest(empty, { id: '1.0.0' })).rejects.toThrow('link.js is not a regular file');
  });

  it('verifyPayload runs on the staged copy and on a matched existing version; a throw is payload_invalid (#1842)', async () => {
    const staged: string[] = [];
    let refuse = false;
    installation = installationOver(fakeLifecycle(), {
      verifyPayload: async (dir) => {
        staged.push(path.relative(installRoot, dir).split(path.sep)[1]!.replace(/^\.staging-.*/u, '.staging'));
        expect(await fs.readFile(path.join(dir, 'host.js'), 'utf8')).toMatch(/^\/\/ /u);
        if (refuse) throw new Error('node too old');
      },
    });
    await installation.install(await payload('1.0.0'));
    await expect(installation.upgrade(await payload('1.0.0'))).rejects.toMatchObject({ code: 'version_current' });
    expect(staged).toEqual(['.staging', '1.0.0']);
    refuse = true;
    const error = await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'payload_invalid', cause: { message: 'node too old' } });
    expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual(['1.0.0']);
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
    // The same files under a different manifest (#1842: Host meta) are a different payload too.
    const relabeled = await payload('2.0.0');
    const manifest = JSON.parse(await fs.readFile(path.join(relabeled, SERVICE_PAYLOAD_MANIFEST), 'utf8')) as ServicePayloadManifest;
    await fs.writeFile(path.join(relabeled, SERVICE_PAYLOAD_MANIFEST), JSON.stringify({ ...manifest, meta: { build: 2 } }));
    await expect(installation.upgrade(relabeled)).rejects.toMatchObject({ code: 'version_conflict' });
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
  describe('store migration (#1577): migrate runs after the snapshot, and every failure restores it', () => {
    const migrating = (verdict: string) => installationOver(fakeLifecycle(), {
      migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, verdict] }),
    });
    /** A retry that stops before its own snapshot leaves no snapshot of the failed attempt for recover() to restore. */
    const expectRetryLeavesNoSnapshot = async (): Promise<void> => {
      await verdicts('rejected');
      await expect(installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toMatchObject({ code: 'store_rejected' });
      await expect(fs.access(path.join(installRoot, 'snapshots', '2.0.0'))).rejects.toThrow();
    };

    it('migrates a migration-required store after the snapshot and switches', async () => {
      installation = migrating('accepted');
      await installation.install(await payload('1.0.0'));
      await verdicts('migration-required');
      events = [];
      const receipt = await installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }));
      expect(receipt).toMatchObject({ state: 'switched', from: '1.0.0', to: '2.0.0', stores: [{ verdict: 'accepted', path: db }] });
      expect(events).toEqual(['stop', 'start', 'health 2.0.0']);
      expect(await fs.readFile(db, 'utf8')).toBe('migrated data');
      // The snapshot holds the store as it was before the migration rewrote it.
      expect(await fs.readFile(path.join(installRoot, 'snapshots', '2.0.0', '0'), 'utf8')).toBe('v1 data');
    });

    it('without migrate, a migration-required store is store_migration_required and the store is unchanged', async () => {
      await installation.install(await payload('1.0.0'));
      await verdicts('migration-required');
      events = [];
      await expect(installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toMatchObject({
        code: 'store_migration_required', stores: [{ verdict: 'migration-required', path: db }],
      });
      expect(events).toEqual(['stop', 'start']);
      expect(await pointer('current')).toBe('1.0.0');
      expect([await fs.readFile(db, 'utf8'), await fs.readFile(`${db}-wal`, 'utf8')]).toEqual(['v1 data', 'v1 wal']);
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_migration_required' });
      await expectRetryLeavesNoSnapshot();
    });

    it('a migration that leaves a store the candidate does not accept is store_migration_failed, with the snapshot restored', async () => {
      installation = migrating('migration-required');
      await installation.install(await payload('1.0.0'));
      await verdicts('migration-required');
      events = [];
      await expect(installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toMatchObject({ code: 'store_migration_failed' });
      expect(events).toEqual(['stop', 'start']);
      expect(await pointer('current')).toBe('1.0.0');
      expect([await fs.readFile(db, 'utf8'), await fs.readFile(`${db}-wal`, 'utf8')]).toEqual(['v1 data', 'v1 wal']);
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_migration_failed' });
      await expectRetryLeavesNoSnapshot();
    });

    it('a death after the migration and before the switch leaves recover() the snapshot to restore', async () => {
      installation = migrating('accepted');
      await installation.install(await payload('1.0.0'));
      await verdicts('migration-required');
      const rename = failRename((destination) => destination === path.join(installRoot, 'previous'));
      try {
        await expect(installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toThrow('injected rename I/O failure');
      } finally {
        rename.restore();
      }
      expect(rename.fired()).toBe(true);
      expect(await installation.receipt()).toMatchObject({ state: 'pending', from: '1.0.0', to: '2.0.0' });
      expect(await fs.readFile(db, 'utf8')).toBe('migrated data');
      expect(await installation.recover()).toMatchObject({ state: 'rolled-back', code: 'upgrade_pending', from: '1.0.0', to: '2.0.0' });
      expect(await pointer('current')).toBe('1.0.0');
      expect([await fs.readFile(db, 'utf8'), await fs.readFile(`${db}-wal`, 'utf8')]).toEqual(['v1 data', 'v1 wal']);
    });
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

  describe('daemon stores (#1328): every store is leased and gated across the switch', () => {
    let research: string;
    beforeEach(async () => {
      research = path.join(root, 'research', 'device');
      await fs.mkdir(research, { recursive: true });
    });
    const both = () => installationOver(fakeLifecycle(), {
      daemonStores: async () => [{ storeDir, productId: 'svc' }, { storeDir: research, productId: 'research' }],
    });

    it('stops both stores and holds their leases and gates through the pointer switch', async () => {
      installation = both();
      await installation.install(await payload('1.0.0'));
      const seen: unknown[] = [];
      const original = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === path.join(installRoot, 'current')) {
          for (const dir of [storeDir, research]) {
            const owner = JSON.parse(await fs.readFile(path.join(dir, 'daemon-owner.json'), 'utf8')) as { role: string };
            const gate = await acquirePathMutationGate({ scope: 'store', targetPath: dir }).catch((error: unknown) => error);
            seen.push([owner.role, gate instanceof PathMutationGateBusyError]);
          }
        }
        return original(from, to);
      });
      try { await expect(installation.upgrade(await payload('2.0.0'))).resolves.toMatchObject({ state: 'switched' }); }
      finally { spy.mockRestore(); }
      expect(seen).toEqual([['installer', true], ['installer', true]]);
      await expect(fs.access(path.join(research, 'daemon-owner.json'))).rejects.toThrow();
    });

    it('a lease that fails to release does not keep the next store leased', async () => {
      installation = both();
      await installation.install(await payload('1.0.0'));
      const original = daemonOwner.acquireDaemonOwner;
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw new Error('injected release failure'); } };
      });
      await expect(installation.upgrade(await payload('2.0.0'))).rejects.toThrow('injected release failure');
      await expect(fs.access(path.join(research, 'daemon-owner.json'))).rejects.toThrow();
    });

    it('a store with a live owner is store_busy and nothing is switched', async () => {
      installation = both();
      await installation.install(await payload('1.0.0'));
      const live = await acquireDaemonOwner(research, 'daemon');
      events = [];
      try { await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'store_busy' }); }
      finally { await live.release(); }
      expect(events).toEqual(['stop', 'start']);
      expect(await pointer('current')).toBe('1.0.0');
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_busy' });
    });

    it('reclaims what a crashed daemon left (a dead owner and a control.token) and upgrades', async () => {
      installation = both();
      await installation.install(await payload('1.0.0'));
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const at = new Date().toISOString();
      await fs.writeFile(path.join(research, 'daemon-owner.json'), JSON.stringify({
        version: 2, pid: dead, nonce: randomUUID(), role: 'daemon', acquiredAt: at, processStartedAt: at, livenessPort: 1,
      }));
      await fs.writeFile(path.join(research, 'control.token'), 'stale');
      await expect(installation.upgrade(await payload('2.0.0'))).resolves.toMatchObject({ state: 'switched' });
      await expect(fs.access(path.join(research, 'control.token'))).rejects.toThrow();
      await expect(fs.access(path.join(research, 'daemon-owner.json'))).rejects.toThrow();
    });

    it.each([
      ['a relative storeDir', async () => [{ storeDir: 'store', productId: 'svc' }]],
      ['a store listed twice', async () => [{ storeDir, productId: 'svc' }, { storeDir: `${storeDir}${path.sep}`, productId: 'other' }]],
      ['an empty productId', async () => [{ storeDir, productId: '' }]],
      ['a throw', async () => { throw new Error('no session'); }],
    ])('%s is daemon_stores_invalid and nothing is switched', async (_label, daemonStores) => {
      await installation.install(await payload('1.0.0'));
      events = [];
      await expect(installationOver(fakeLifecycle(), { daemonStores }).upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'daemon_stores_invalid' });
      expect(events).toEqual(['stop', 'start']);
      expect(await pointer('current')).toBe('1.0.0');
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'daemon_stores_invalid' });
    });

    it('daemonStores without healthCheck is a TypeError', () => {
      expect(() => installationOver(fakeLifecycle(), { daemonStores: async () => [], healthCheck: undefined })).toThrow(TypeError);
    });
  });

  describe('store verdicts (#1328): Host stores, directory stores and the lstat check', () => {
    let index: string;
    const verdictsWith = async (...extra: object[]): Promise<void> => {
      await fs.writeFile(path.join(root, 'verdicts.json'), JSON.stringify([
        { store: 'client-journal', path: db, verdict: 'accepted', reason: 'ok' }, ...extra,
      ]));
    };
    beforeEach(async () => {
      index = path.join(root, 'research-index');
      await fs.mkdir(path.join(index, 'shards'), { recursive: true });
      await fs.writeFile(path.join(index, 'shards', 'a'), 'v1 a');
      await fs.symlink('shards/a', path.join(index, 'latest'));
      await verdictsWith({ store: 'research-index', path: index, kind: 'directory', verdict: 'accepted', reason: 'ok' });
    });

    it('a Host directory store enters the receipt and is restored with its snapshot after a failed health check', async () => {
      await installation.install(await payload('1.0.0'));
      const switched = await installation.upgrade(await payload('2.0.0'));
      expect(switched.stores).toContainEqual(expect.objectContaining({ store: 'research-index', kind: 'directory' }));
      const before = await tree(index);
      unhealthy.add('3.0.0');
      onHealth = async (version) => {
        if (version !== '3.0.0') return;
        await fs.writeFile(path.join(index, 'shards', 'a'), 'v3 a');
        await fs.writeFile(path.join(index, 'shards', 'b'), 'v3 b');
        await fs.rm(path.join(index, 'latest'));
      };
      await expect(installation.upgrade(await payload('3.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
      expect(await tree(index)).toEqual(before);
    });

    it.each([['/', false], ['/.', false], ['/./', false], ['/.', true]] as const)('restores a directory store spelled with suffix %j, replaced by a file: %s (#1350)', async (suffix, replaced) => {
      await verdictsWith({ store: 'research-index', path: `${index}${suffix}`, kind: 'directory', verdict: 'accepted', reason: 'ok' });
      await installation.install(await payload('1.0.0'));
      const before = await tree(index);
      unhealthy.add('2.0.0');
      onHealth = async (version) => {
        if (version !== '2.0.0') return;
        await fs.writeFile(db, 'v2 data');
        await fs.rm(index, { recursive: true });
        if (replaced) await fs.writeFile(index, 'v2 file');
        else await fs.mkdir(index);
      };
      await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
      expect(await tree(index)).toEqual(before);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(await pointer('current')).toBe('1.0.0');
      expect(await installation.receipt()).toMatchObject({ state: 'rolled-back', code: 'health_check_failed' });
    });

    it.each([false, true])('recovers an old pending snapshot spelled /., refusing a root symlink first: %s (#1350)', async (symlink) => {
      await installation.install(await payload('1.0.0'));
      const before = await tree(index);
      await installation.upgrade(await payload('2.0.0'));
      const snapshotFile = path.join(installRoot, 'snapshots', '2.0.0', 'snapshot.json');
      const snapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8')) as { entries: Array<{ path: string }> };
      snapshot.entries[1]!.path = `${index}/.`; // The old persisted spelling; path.join would normalize it.
      await fs.writeFile(snapshotFile, JSON.stringify(snapshot));
      const pending = { ...(await installation.receipt()), state: 'pending' };
      await fs.writeFile(path.join(installRoot, 'upgrade-receipt.json'), JSON.stringify(pending));
      await fs.writeFile(db, 'v2 data');
      if (symlink) {
        await fs.rename(index, `${index}-target`);
        await fs.symlink(`${index}-target`, index, 'dir');
        await expect(installation.recover()).rejects.toMatchObject({ code: 'precheck_failed' });
        expect(await fs.readFile(db, 'utf8')).toBe('v2 data'); // The earlier file store is untouched.
        expect(await installation.receipt()).toEqual(pending);
      } else {
        await expect(installation.recover()).resolves.toMatchObject({ state: 'rolled-back', code: 'upgrade_pending' });
        expect(await tree(index)).toEqual(before);
        expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
        expect(await pointer('current')).toBe('1.0.0');
      }
    });

    it('a directory store absent at the snapshot is removed on restore', async () => {
      await fs.rm(index, { recursive: true });
      await installation.install(await payload('1.0.0'));
      unhealthy.add('2.0.0');
      onHealth = async (version) => { if (version === '2.0.0') await fs.mkdir(index); };
      await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
      await expect(fs.lstat(index)).rejects.toThrow();
    });

    it.each([
      ['a store id outside the pattern', () => verdictsWith({ store: 'Research', path: index, kind: 'directory', verdict: 'accepted', reason: 'ok' })],
      ['an unknown kind', () => verdictsWith({ store: 'research-index', path: index, kind: 'tree', verdict: 'accepted', reason: 'ok' })],
      ['a repeated path', () => verdictsWith({ store: 'other', path: db, verdict: 'accepted', reason: 'ok' })],
      ['a store inside a directory store', () => verdictsWith(
        { store: 'research-index', path: index, kind: 'directory', verdict: 'accepted', reason: 'ok' },
        { store: 'shard', path: path.join(index, 'shards', 'a'), verdict: 'accepted', reason: 'ok' },
      )],
      ['a file store that is a directory', () => verdictsWith({ store: 'research-index', path: index, verdict: 'accepted', reason: 'ok' })],
      ['a directory store that is a symlink', async () => {
        await fs.symlink(index, path.join(root, 'index-link'));
        await verdictsWith({ store: 'research-index', path: path.join(root, 'index-link'), kind: 'directory', verdict: 'accepted', reason: 'ok' });
      }],
      ['a file store that is a symlink', async () => {
        await fs.symlink(db, path.join(root, 'db-link'));
        await fs.writeFile(path.join(root, 'verdicts.json'), JSON.stringify([{ store: 'client-journal', path: path.join(root, 'db-link'), verdict: 'accepted', reason: 'ok' }]));
      }],
    ])('%s is precheck_failed and nothing is switched', async (_label, write) => {
      await installation.install(await payload('1.0.0'));
      await write();
      await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'precheck_failed' });
      expect(await pointer('current')).toBe('1.0.0');
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'precheck_failed' });
    });

    it('a failed cleanup of the partial snapshot does not replace snapshot_failed', async () => {
      await installation.install(await payload('1.0.0'));
      const partial = path.join(installRoot, 'snapshots', '2.0.0');
      const realRm = fs.rm.bind(fs);
      let copied = false;
      const cp = vi.spyOn(fs, 'cp').mockImplementationOnce(async () => { copied = true; throw Object.assign(new Error('injected'), { code: 'ENOSPC' }); });
      const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (copied && String(target) === partial) throw Object.assign(new Error('injected cleanup'), { code: 'EBUSY' });
        return realRm(target, options);
      });
      try { await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'snapshot_failed', cause: { code: 'ENOSPC' } }); }
      finally { cp.mockRestore(); rm.mockRestore(); }
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'snapshot_failed' });
    });

    it('a copy that fails is snapshot_failed: no partial snapshot, no pending receipt, the old version restarted', async () => {
      await installation.install(await payload('1.0.0'));
      const spy = vi.spyOn(fs, 'cp').mockRejectedValueOnce(Object.assign(new Error('injected'), { code: 'ENOSPC' }));
      events = [];
      try { await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'snapshot_failed', cause: { code: 'ENOSPC' } }); }
      finally { spy.mockRestore(); }
      expect(events).toEqual(['stop', 'start']);
      expect(await pointer('current')).toBe('1.0.0');
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'snapshot_failed' });
      await expect(fs.access(path.join(installRoot, 'snapshots', '2.0.0'))).rejects.toThrow();
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
