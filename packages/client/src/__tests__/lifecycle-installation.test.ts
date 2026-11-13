import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
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
import { SERVICE_UNIT_MARKER, ServiceUnitError, withServiceOwnerGate } from '../lifecycle/service-unit';
import * as daemonOwner from '../util/daemon-owner';
import { acquireDaemonOwner } from '../util/daemon-owner';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../util/path-mutation-gate';
import { OwnedProcessLedger, OwnedProcessResidueError, type OwnedProcessReconciliation } from '../daemon/owned-process-ledger';
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

/** Fails every copy out of a snapshot while `active()` holds: the restore removes the store files, then cannot put them back. */
function failRestore(active: () => boolean = () => true): { restoreError: Error; restore: () => void } {
  const originalCopy = fs.copyFile.bind(fs);
  const restoreError = Object.assign(new Error('restore copy denied'), { code: 'EACCES' });
  const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
    if (active() && String(from).startsWith(`${path.join(installRoot, 'snapshots')}${path.sep}`)) throw restoreError;
    return originalCopy(from, to, mode);
  });
  return { restoreError, restore: () => spy.mockRestore() };
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
    expect(events).toEqual(['stop', 'install', 'start', 'health 1.0.0']);
    // A same-id reinstall must confirm health too; another version must be upgraded.
    await installation.install(await payload('1.0.0'));
    expect(events).toEqual(['stop', 'install', 'start', 'health 1.0.0', 'install', 'start', 'health 1.0.0']);
    const refused = await payload('2.0.0');
    await expect(installation.install(refused)).rejects.toMatchObject({ code: 'installation_exists' });
    expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual(['1.0.0']);
    expect(await pointer('current')).toBe('1.0.0');
    expect(await readServiceInstallationRecord(storeDir)).toEqual({ format: 'byok-service-installation', version: 1, installRoot });
    // A corrected payload with the refused id can still be upgraded later.
    await installation.upgrade(await payload('2.0.0', { 'host.js': '// corrected 2.0.0' }));
    expect(await pointer('current')).toBe('2.0.0');
    expect(await fs.readFile(path.join(installRoot, 'versions', '2.0.0', 'host.js'), 'utf8')).toBe('// corrected 2.0.0');
  });

  it.each(['first install', 'same-id reinstall', 'activation failure', 'typed activation failure'])('%s removes installation artifacts when startup fails, preserving stores (#1966)', async (mode) => {
    const healthError = mode === 'typed activation failure'
      ? new ServiceUnitError('service_unload_timeout')
      : new Error(mode === 'activation failure' ? 'service activation failed' : 'identity endpoint is unhealthy');
    const unitPath = path.join(root, 'service.unit');
    const launcherPath = path.join(root, 'launcher');
    let running = false;
    const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app', program: { command: process.execPath, args: [] } };
    const unit: PlatformUnit = {
      serviceName: 'svc', unitPath, launcherPath,
      files: () => [unitPath, launcherPath].map((file) => ({ path: file, content: SERVICE_UNIT_MARKER })),
      activate: async () => { running = true; if (mode.endsWith('activation failure')) throw healthError; },
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

  it('refuses a foreign unit before staging or writing installation artifacts (#1966)', async () => {
    const unitPath = path.join(root, 'foreign.unit');
    const launcherPath = path.join(root, 'foreign.launcher');
    await fs.writeFile(unitPath, 'operator unit');
    await fs.writeFile(launcherPath, 'operator launcher');
    installation = installationOver({
      ...fakeLifecycle(),
      inspect: async () => ({ state: 'foreign', unitPath, launcherPath }),
    });
    await expect(installation.install(await payload('1.0.0'))).rejects.toMatchObject({ code: 'service_unit_unmarked' });
    await expect(fs.lstat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
    expect(await fs.readFile(unitPath, 'utf8')).toBe('operator unit');
    expect(await fs.readFile(launcherPath, 'utf8')).toBe('operator launcher');
    expect(events).toEqual([]);
  });

  it.each(['ignores abort forever', 'succeeds after the deadline before the timer fires'])('install enforces its health-check deadline when %s (#1966)', async (mode) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    let signal: AbortSignal | undefined;
    installation = installationOver(fakeLifecycle(), {
      healthTimeoutMs: 50,
      healthCheck: async (value) => {
        signal = value;
        entered();
        if (mode === 'ignores abort forever') await pending;
        else vi.setSystemTime(Date.now() + 51);
      },
    });
    const candidate = await payload('1.0.0');
    vi.useFakeTimers();
    try {
      const installing = installation.install(candidate).catch((caught: unknown) => caught);
      await began;
      // The late-success case advances only the wall clock inside the
      // check, exercising the post-race deadline check before abort fires.
      if (mode === 'ignores abort forever') await vi.advanceTimersByTimeAsync(51);
      const error = await installing;
      expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { message: 'the service health check timed out after 50 ms' } });
      expect(await installation.currentVersion()).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);
      expect(events.at(-1)).toBe('uninstall');
      expect(signal?.aborted).toBe(mode === 'ignores abort forever');
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('upgrade, rollback and recover enforce the health-check deadline against a check that ignores abort or succeeds late (#1977)', async () => {
    await installation.install(await payload('1.0.0'));
    const signals: AbortSignal[] = [];
    let mode: 'hang' | 'late' | 'ok' = 'hang';
    installation = installationOver(fakeLifecycle(), {
      healthTimeoutMs: 50,
      healthCheck: async (signal) => {
        signals.push(signal);
        if (mode === 'hang') await new Promise<void>(() => undefined);
        if (mode === 'late') { mode = 'ok'; await new Promise((resolve) => setTimeout(resolve, 100)); }
      },
    });
    await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'rollback_unhealthy' });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(await installation.receipt()).toMatchObject({ state: 'failed', from: '1.0.0', to: '2.0.0', code: 'rollback_unhealthy' });
    expect(await pointer('current')).toBe('1.0.0');

    // A candidate check that succeeds after the deadline fails; the restored version passes.
    mode = 'late';
    await expect(installation.upgrade(await payload('2.0.0'))).rejects.toMatchObject({ code: 'health_check_failed' });
    expect(await installation.receipt()).toMatchObject({ state: 'rolled-back', code: 'health_check_failed' });

    // rollback() and recover() called directly.
    await installation.upgrade(await payload('2.0.0'));
    mode = 'hang';
    await expect(installation.rollback()).resolves.toMatchObject({ state: 'failed', code: 'rollback_unhealthy' });
    const killed = new Error('process killed');
    const doomed = installationOver({ ...fakeLifecycle(), stop: async () => { throw killed; }, start: async () => { throw killed; } });
    await expect(doomed.upgrade(await payload('3.0.0'))).rejects.toThrow('process killed');
    await expect(installation.recover()).resolves.toMatchObject({ state: 'failed', code: 'rollback_unhealthy' });
  });

  it.each([0, -1, 1.5, 2 ** 31, Number.NaN])('healthTimeoutMs %s is a TypeError (#1977)', (healthTimeoutMs) => {
    expect(() => installationOver(fakeLifecycle(), { healthTimeoutMs })).toThrow(TypeError);
    expect(() => installationOver(fakeLifecycle(), { healthTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it('starts the install health-check deadline after an in-flight platform start settles (#1966)', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const began = new Promise<void>((resolve) => { entered = resolve; });
    installation = installationOver({
      ...fakeLifecycle(),
      start: async () => { events.push('start'); entered(); await pending; },
    }, { healthTimeoutMs: 50 });
    const candidate = await payload('1.0.0');
    vi.useFakeTimers();
    try {
      const installing = installation.install(candidate);
      await began;
      await vi.advanceTimersByTimeAsync(51);
      expect(events).not.toContain('uninstall');
      release();
      await installing;
      expect(await installation.currentVersion()).toBe('1.0.0');
      expect(events).toEqual(['stop', 'install', 'start', 'health 1.0.0']);
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
      expect(events).toContain('uninstall');
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
    expect((error as Error).message).toContain('Remaining: service unit and launcher, current pointer, installation record, staged version directory, prepared store snapshot restoration, store lease release, install snapshot directory');
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

    // Pruning after the switch is cleanup (#1986): a removal failure keeps the committed upgrade, and the next prune removes it.
    const originalRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === path.join(installRoot, 'snapshots', '3.0.0')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalRm(target, options);
    });
    const switched = await installation.upgrade(await payload('4.0.0')).finally(() => rm.mockRestore());
    expect(switched).toMatchObject({ state: 'switched', from: '3.0.0', to: '4.0.0' });
    expect((await fs.readdir(path.join(installRoot, 'snapshots'))).sort()).toEqual(['3.0.0', '4.0.0']);
    await installation.upgrade(await payload('5.0.0'));
    expect((await fs.readdir(path.join(installRoot, 'versions'))).sort()).toEqual(['4.0.0', '5.0.0']);
    expect(await fs.readdir(path.join(installRoot, 'snapshots'))).toEqual(['5.0.0']);
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
  describe('install store preparation (#1983)', () => {
    const migrating = (verdict = 'accepted') => installationOver(fakeLifecycle(), {
      precheck: (versionDir) => {
        events.push('precheck');
        return { command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] };
      },
      migrate: (versionDir) => {
        events.push('migrate');
        return { command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, verdict] };
      },
    });
    const snapshotNames = async () => fs.readdir(path.join(installRoot, 'snapshots'));
    const expectUninstalled = async (versions: string[] = []) => {
      expect(await pointer('current')).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual(versions);
      expect(events).not.toContain('install');
      expect(Object.keys(await tree(installRoot)).some((file) => file.startsWith(path.join('snapshots', '.install-')))).toBe(false);
    };

    it('snapshots and migrates kept stores before installing, then confirms health', async () => {
      installation = migrating();
      await verdicts('migration-required');
      onHealth = async () => {
        expect(await fs.readFile(db, 'utf8')).toBe('migrated data');
        const snapshots = await fs.readdir(path.join(installRoot, 'snapshots'));
        expect(snapshots).toHaveLength(1);
        expect(await fs.readFile(path.join(installRoot, 'snapshots', snapshots[0]!, '0'), 'utf8')).toBe('v1 data');
      };
      await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE }));
      expect(events).toEqual(['stop', 'precheck', 'migrate', 'precheck', 'install', 'start', 'health 2.0.0']);
      expect(await pointer('current')).toBe('2.0.0');
      expect(await fs.readdir(path.join(installRoot, 'snapshots'))).toEqual([]);
      expect(await installation.receipt()).toBeUndefined();
    });

    it('resolves a healthy migrated install when temporary snapshot removal fails', async () => {
      const unitPath = path.join(root, 'service.unit');
      const launcherPath = path.join(root, 'service.launcher');
      let running = false;
      const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app', program: { command: process.execPath, args: [] } };
      const unit: PlatformUnit = {
        serviceName: 'svc', unitPath, launcherPath,
        files: () => [unitPath, launcherPath].map((file) => ({ path: file, content: SERVICE_UNIT_MARKER })),
        activate: async () => { running = true; }, deactivate: async () => { running = false; },
        removeFiles: async () => { for (const file of [unitPath, launcherPath]) await fs.rm(file); },
        start: async () => { running = true; }, stop: async () => { running = false; },
        query: async () => ({ running, determinate: true, detail: 'fake' }),
      };
      installation = installationOver(createManagedLifecycle(def, unit), {
        migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] }),
      });
      await verdicts('migration-required');
      let healthy = false;
      let leftover: string | undefined;
      onHealth = async () => { healthy = true; };
      const originalRm = fs.rm.bind(fs);
      const fault = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (healthy && path.dirname(String(file)) === path.join(installRoot, 'snapshots') && path.basename(String(file)).startsWith('.install-')) {
          leftover = String(file);
          throw Object.assign(new Error('snapshot cleanup denied'), { code: 'EACCES' });
        }
        return originalRm(file, options);
      });
      try {
        await expect(installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).resolves.toBeUndefined();
      } finally {
        fault.mockRestore();
      }
      expect(leftover).toBeDefined();
      expect(await installation.lifecycle.status()).toMatchObject({ installed: true, running: true });
      expect(await pointer('current')).toBe('2.0.0');
      expect(await readServiceInstallationRecord(storeDir)).toMatchObject({ installRoot });
      expect(await fs.readFile(db, 'utf8')).toBe('migrated data');
      expect(await fs.readFile(path.join(leftover!, '0'), 'utf8')).toBe('v1 data');
      expect(await installation.receipt()).toBeUndefined();
    });

    it('takes the repair inventory under the store lease and refuses to choose between two repair snapshots', async () => {
      const repairs = [`.install-repair-${randomUUID()}`, `.install-repair-${randomUUID()}`];
      for (const name of repairs) await fs.mkdir(path.join(installRoot, 'snapshots', name), { recursive: true });
      const error = await installation.install(await payload('2.0.0')).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      for (const name of repairs) expect((error as Error).message).toContain(path.join(installRoot, 'snapshots', name));
      expect(events).toEqual(['stop', 'uninstall']);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect((await snapshotNames()).sort()).toEqual(repairs.sort());
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);
      for (const name of repairs) await fs.rm(path.join(installRoot, 'snapshots', name), { recursive: true });

      // Owner gates under different gate roots do not exclude each other; owned() without the gate models
      // that. B's restore fails and leaves a repair snapshot after A listed and before A takes the lease.
      const ungated = (base: ManagedServiceLifecycle): ManagedServiceLifecycle => ({ ...base, owned: (operation) => operation({ install: base.install, uninstall: base.uninstall }) });
      const migrate: ServiceInstallationOptions['migrate'] = (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] });
      const b = installationOver(ungated(fakeLifecycle()), { migrate });
      installation = installationOver({ ...ungated(fakeLifecycle()), stop: async () => {
        await verdicts('migration-required');
        const fault = failRestore();
        try {
          await expect(b.install(await payload('2.0.0', { 'migrate.cjs': `${MIGRATE}\nprocess.exit(1);` }))).rejects.toBeInstanceOf(AggregateError);
        } finally {
          fault.restore();
        }
        await verdicts('accepted');
      } });
      await installation.install(await payload('3.0.0'));
      expect(await pointer('current')).toBe('3.0.0');
      expect(await snapshotNames()).toEqual([]);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');

      // B installs after A read `current` and before A holds the lease: A reads it again under the lease, refuses
      // before its precheck, and keeps every version directory, which B may share (same id) or own.
      for (const [ours, theirs] of [['5.0.0', '4.0.0'], ['5.0.0', '5.0.0']] as const) {
        await installation.uninstall();
        let prechecked = false;
        installation = installationOver({ ...ungated(fakeLifecycle()), stop: async () => { await b.install(await payload(theirs)); } }, {
          migrate,
          precheck: (versionDir) => {
            prechecked = true;
            return { command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] };
          },
        });
        // Same id: the refused install's own lease then fails to release; the version directory still stays.
        vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockRestore();
        const real = daemonOwner.acquireDaemonOwner;
        let taken = 0;
        const leaseFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(async (...args) => {
          const lease = await real(...args);
          return ours === theirs && taken++ === 1 ? { release: async () => { await lease.release(); throw new Error('injected release failure'); } } : lease;
        });
        const refused = await installation.install(await payload(ours)).catch((caught: unknown) => caught).finally(() => leaseFault.mockRestore());
        // The refusal keeps its class and code; the release failure joins its cause (#1991).
        expect(refused).toMatchObject({ code: 'installation_exists' });
        expect(prechecked).toBe(false);
        expect(await pointer('current')).toBe(theirs);
        expect(await fs.readFile(path.join(installRoot, 'versions', theirs, 'host.js'), 'utf8')).toBe(`// ${theirs}`);
        expect(await snapshotNames()).toEqual([]);
      }
    });

    it('uninstall refuses a symlinked snapshots/ and changes nothing behind it', async () => {
      await installation.install(await payload('1.0.0'));
      const outside = path.join(root, 'outside');
      await fs.mkdir(path.join(outside, `.install-${randomUUID()}`), { recursive: true });
      await fs.writeFile(path.join(outside, 'unrelated'), 'unrelated data');
      await fs.rm(path.join(installRoot, 'snapshots'), { recursive: true, force: true });
      await fs.symlink(outside, path.join(installRoot, 'snapshots'));
      const before = await tree(outside);
      const symlinked = await installation.uninstall().catch((caught: unknown) => caught);
      expect(symlinked).toBeInstanceOf(ServiceInstallationError);
      expect(symlinked).toMatchObject({ code: 'snapshots_symlinked', message: expect.stringContaining(path.join(installRoot, 'snapshots')) });
      // Only an absent snapshots/ passes the check; any other lstat error is the caller's.
      const originalLstat = fs.lstat.bind(fs);
      const denied = Object.assign(new Error('lstat denied'), { code: 'EACCES' });
      const fault = vi.spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
        if (String(file) === path.join(installRoot, 'snapshots')) throw denied;
        return originalLstat(file, options);
      });
      try {
        await expect(installation.uninstall()).rejects.toBe(denied);
      } finally {
        fault.mockRestore();
      }
      expect(await tree(outside)).toEqual(before);
      expect(events).not.toContain('uninstall');
      expect(await pointer('current')).toBe('1.0.0');
    });

    it('a later upgrade and uninstall keep install and repair snapshots, and snapshots/ around them', async () => {
      await installation.install(await payload('1.0.0'));
      const kept = [`.install-${randomUUID()}`, `.install-repair-${randomUUID()}`].sort();
      for (const name of kept) {
        await fs.mkdir(path.join(installRoot, 'snapshots', name), { recursive: true });
        await fs.writeFile(path.join(installRoot, 'snapshots', name, 'snapshot.json'), name);
      }
      await expect(installation.upgrade(await payload('2.0.0'))).resolves.toMatchObject({ state: 'switched', from: '1.0.0', to: '2.0.0' });
      expect((await fs.readdir(path.join(installRoot, 'snapshots'))).sort()).toEqual(['2.0.0', ...kept].sort());
      await installation.uninstall();
      expect(await fs.readdir(installRoot)).toEqual(['snapshots']);
      expect((await fs.readdir(path.join(installRoot, 'snapshots'))).sort()).toEqual(kept);
      for (const name of kept) expect(await fs.readFile(path.join(installRoot, 'snapshots', name, 'snapshot.json'), 'utf8')).toBe(name);
    });

    it.each([
      { verdict: 'rejected', reused: false }, { verdict: 'new-path-repair', reused: false },
      { verdict: 'rejected', reused: true }, { verdict: 'new-path-repair', reused: true },
    ])('refuses $verdict before writing a pointer, record or unit (reused staging: $reused)', async ({ verdict, reused }) => {
      installation = migrating();
      await verdicts(verdict);
      const candidate = await payload('2.0.0');
      if (reused) await fs.cp(candidate, path.join(installRoot, 'versions', '2.0.0'), { recursive: true });
      await expect(installation.install(candidate)).rejects.toMatchObject({ code: verdict === 'rejected' ? 'store_rejected' : 'store_repair_required' });
      // A version directory this call did not create may belong to another installation: it stays (#1991).
      await expectUninstalled(reused ? ['2.0.0'] : []);
      await expect(fs.lstat(path.join(installRoot, 'snapshots'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(events).toEqual(['stop', 'precheck', 'start']);
    });

    it.each(['migration exits nonzero', 'postcheck still requires migration', 'migration setup throws', 'postcheck fails'])('restores kept stores and removes staging when %s', async (mode) => {
      const setupError = new Error('no migration program');
      installation = mode === 'migration setup throws'
        ? installationOver(fakeLifecycle(), { migrate: () => { throw setupError; } })
        : migrating(mode === 'postcheck still requires migration' ? 'migration-required' : 'accepted');
      await verdicts('migration-required');
      const script = { 'migration exits nonzero': `${MIGRATE}\nprocess.exit(1);`, 'postcheck fails': `${MIGRATE}\nfs.writeFileSync(verdictsPath, '{');` }[mode] ?? MIGRATE;
      // Every failure after the snapshot is store_migration_failed; a setup or precheck error is its cause (#1984).
      const failed = await installation.install(await payload('2.0.0', { 'migrate.cjs': script })).catch((caught: unknown) => caught);
      expect(failed).toMatchObject({ code: 'store_migration_failed' });
      if (mode === 'migration setup throws') expect((failed as Error).cause).toBe(setupError);
      if (mode === 'postcheck fails') expect((failed as Error).cause).toMatchObject({ code: 'precheck_failed' });
      await expectUninstalled();
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');

      // A lease that then fails to release joins the store error instead of being dropped.
      await verdicts('migration-required');
      const releaseError = new Error('injected release failure');
      const original = daemonOwner.acquireDaemonOwner;
      const leaseFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      try {
        const error = await installation.install(await payload('2.0.0', { 'migrate.cjs': script })).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceInstallationError);
        expect(error).toMatchObject({ code: 'store_migration_failed', cause: { errors: [expect.objectContaining({ code: 'store_migration_failed' }), releaseError] } });
      } finally {
        leaseFault.mockRestore();
      }
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it('without migrate refuses migration-required and keeps the stores intact', async () => {
      await verdicts('migration-required');
      await expect(installation.install(await payload('2.0.0'))).rejects.toMatchObject({ code: 'store_migration_required' });
      await expectUninstalled();
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it('removes the failed installation and restores stores after migration then health failure', async () => {
      installation = migrating();
      await verdicts('migration-required');
      unhealthy.add('2.0.0');
      onHealth = async () => {
        await fs.writeFile(db, 'candidate data');
        await fs.rm(`${db}-wal`);
        await fs.writeFile(`${db}-journal`, 'candidate journal');
      };
      await expect(installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toMatchObject({ code: 'install_health_check_failed' });
      expect(events).toContain('uninstall');
      expect(await pointer('current')).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');
      await expect(fs.lstat(`${db}-journal`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['after', 'before'] as const)('keeps and names the unrestored migration snapshot when the failed service cannot be removed %s activation', async (when) => {
      const base = fakeLifecycle();
      const removal = new Error('service is still running');
      installation = installationOver({
        ...base,
        owned: (operation) => withServiceOwnerGate(() => operation({
          install: base.install, uninstall: async () => { throw removal; },
        })),
      }, {
        migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] }),
      });
      await verdicts('migration-required');
      unhealthy.add('2.0.0');
      onHealth = async () => { await fs.writeFile(db, 'live candidate data'); };
      const fault = when === 'before' ? failRename((file) => file === path.join(installRoot, 'current')) : undefined;
      let error: unknown;
      try {
        error = await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught);
      } finally {
        fault?.restore();
      }
      expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { errors: [expect.anything(), removal] } });
      expect((error as Error).message).toContain('prepared store snapshot restoration');
      expect(await fs.readFile(db, 'utf8')).toBe(when === 'after' ? 'live candidate data' : 'migrated data');
      const snapshots = await snapshotNames();
      expect(snapshots).toEqual([expect.not.stringMatching(/^\.install-repair-/u)]);
      expect((error as Error).message).toContain(path.join(installRoot, 'snapshots', snapshots[0]!));
      expect(await pointer('current')).toBe(when === 'after' ? '2.0.0' : undefined);
      expect(await fs.readFile(path.join(installRoot, 'snapshots', snapshots[0]!, '0'), 'utf8')).toBe('v1 data');
      // Nothing of the failed call still holds the stores.
      await (await acquireDaemonOwner(storeDir, 'daemon')).release();
      await (await acquirePathMutationGate({ scope: 'store', targetPath: storeDir })).release();
    });

    it.each(['its removal failed after a completed restore', 'its restore and its repair rename failed'] as const)('refuses the next first install over an install snapshot leftover: %s', async (mode) => {
      installation = installationOver(fakeLifecycle(), {
        migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] }),
      });
      await verdicts('migration-required');
      const candidate = await payload('2.0.0', { 'migrate.cjs': `${MIGRATE}\nprocess.exit(1);` });
      const originalRm = fs.rm.bind(fs);
      const removal = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (mode === 'its removal failed after a completed restore' && path.basename(String(file)).startsWith('.install-') && existsSync(path.join(String(file), 'snapshot.json'))) {
          throw Object.assign(new Error('snapshot cleanup denied'), { code: 'EACCES' });
        }
        return originalRm(file, options);
      });
      const restore = mode === 'its restore and its repair rename failed' ? failRestore() : undefined;
      const rename = mode === 'its restore and its repair rename failed' ? failRename((to) => path.basename(to).startsWith('.install-repair-')) : undefined;
      try {
        const first = await installation.install(candidate).catch((caught: unknown) => caught);
        if (mode === 'its removal failed after a completed restore') {
          expect(first).toMatchObject({ code: 'store_migration_failed' });
          expect(events.at(-1)).toBe('start');
          expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
        } else {
          expect(rename!.fired()).toBe(true);
          expect(first).toBeInstanceOf(AggregateError);
          expect(events).not.toContain('start');
          expect(existsSync(db)).toBe(false);
        }
      } finally {
        removal.mockRestore();
        restore?.restore();
        rename?.restore();
      }
      const leftover = await snapshotNames();
      expect(leftover).toEqual([expect.not.stringMatching(/^\.install-repair-/u)]);
      // Whatever the stores hold now, the leftover may be their only copy: the next install refuses and starts nothing.
      if (existsSync(db)) await fs.writeFile(db, 'later data');
      await verdicts(existsSync(db) ? 'accepted' : 'absent');
      events = [];
      const blocked = await installation.install(candidate).catch((caught: unknown) => caught);
      expect(blocked).toBeInstanceOf(ServiceInstallationError);
      expect(blocked).toMatchObject({ code: 'install_snapshot_leftover', message: expect.stringContaining(path.join(installRoot, 'snapshots', leftover[0]!)) });
      expect(events).not.toContain('start');
      expect(await pointer('current')).toBeUndefined();
      expect(await snapshotNames()).toEqual(leftover);
      if (mode === 'its removal failed after a completed restore') expect(await fs.readFile(db, 'utf8')).toBe('later data');
    });

    it('with no stores prepares an empty list and installs without migration', async () => {
      installation = migrating();
      await fs.writeFile(path.join(root, 'verdicts.json'), '[]');
      await installation.install(await payload('2.0.0'));
      expect(events).toEqual(['stop', 'precheck', 'install', 'start', 'health 2.0.0']);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it.each([
      { state: 'exact', refused: false }, { state: 'repairable', refused: true },
    ] as const)('stops a running owned $state unit and restarts after preparation refusal: $refused', async ({ state, refused }) => {
      const base = fakeLifecycle();
      let owner = await acquireDaemonOwner(storeDir, 'daemon');
      installation = installationOver({
        ...base,
        inspect: async () => ({ state, owner: 'app', unitPath: 'unit', launcherPath: 'launcher' }),
        stop: async () => { events.push('stop'); await owner.release(); },
        start: async () => {
          events.push('start');
          if (refused) {
            await expect(fs.lstat(path.join(installRoot, 'versions', '2.0.0'))).rejects.toMatchObject({ code: 'ENOENT' });
          }
          // Proves preparation released all leases/gates before starting.
          owner = await acquireDaemonOwner(storeDir, 'daemon');
        },
      });
      await verdicts(refused ? 'rejected' : 'accepted');
      try {
        const installing = installation.install(await payload('2.0.0'));
        if (refused) {
          await expect(installing).rejects.toMatchObject({ code: 'store_rejected' });
          expect(events).toEqual(['stop', 'start']);
          await expectUninstalled();
        } else {
          await expect(installing).resolves.toBeUndefined();
          expect(events).toEqual(['stop', 'install', 'start', 'health 2.0.0']);
          expect(await pointer('current')).toBe('2.0.0');
        }
      } finally {
        await owner.release();
      }
    });

    it.each(['absent', 'foreign'] as const)('refuses a busy daemon store without stopping the %s unit', async (state) => {
      const unitPath = path.join(root, 'unit');
      await fs.writeFile(unitPath, 'operator unit');
      installation = installationOver({
        ...fakeLifecycle(), inspect: async () => ({ state, unitPath, launcherPath: unitPath }),
      }, { stopTimeoutMs: 25 });
      const owner = await acquireDaemonOwner(storeDir, 'daemon');
      try {
        await expect(installation.install(await payload('2.0.0'), { replaceUnmarked: state === 'foreign' })).rejects.toMatchObject({ code: 'store_busy' });
      } finally {
        await owner.release();
      }
      await expectUninstalled();
      expect(events).toEqual([]);
      expect(await fs.readFile(unitPath, 'utf8')).toBe('operator unit');
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it('replaces an allowed unmarked unit only after its stores are prepared', async () => {
      const unitPath = path.join(root, 'legacy.unit');
      const launcherPath = path.join(root, 'legacy.launcher');
      await fs.writeFile(unitPath, 'operator unit');
      const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app', program: { command: process.execPath, args: [] } };
      const unit: PlatformUnit = {
        serviceName: 'svc', unitPath, launcherPath,
        files: () => [unitPath, launcherPath].map((file) => ({ path: file, content: SERVICE_UNIT_MARKER })),
        activate: async () => { events.push('activate'); },
        deactivate: async () => { throw new Error('must not stop the unmarked unit during preparation'); },
        removeFiles: async () => undefined,
        start: async () => { events.push('start'); }, stop: async () => { throw new Error('must not stop the unmarked unit during preparation'); },
        query: async () => ({ running: true, determinate: true, detail: 'fake' }),
      };
      installation = installationOver(createManagedLifecycle(def, unit), {
        precheck: (versionDir) => {
          events.push('precheck');
          return { command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] };
        },
      });
      await installation.install(await payload('2.0.0'), { replaceUnmarked: true });
      expect(events).toEqual(['precheck', 'activate', 'start', 'health 2.0.0']);
      expect(await fs.readFile(unitPath, 'utf8')).toBe(SERVICE_UNIT_MARKER);
    });

    it.each(['current', 'installation.json'])('restores migrated stores after a failed %s write without touching an allowed foreign unit', async (target) => {
      const unitPath = path.join(root, 'foreign.unit');
      await fs.writeFile(unitPath, 'operator unit');
      const base = fakeLifecycle();
      const uninstall = vi.fn(async () => { throw new ServiceUnitError('service_unit_unmarked'); });
      installation = installationOver({
        ...base,
        inspect: async () => ({ state: 'foreign', unitPath, launcherPath: unitPath }),
        owned: (operation) => withServiceOwnerGate(() => operation({ install: base.install, uninstall })),
      }, {
        migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] }),
      });
      await verdicts('migration-required');
      const candidate = await payload('2.0.0', { 'migrate.cjs': MIGRATE });
      const destination = target === 'current' ? path.join(installRoot, target) : path.join(storeDir, 'service', target);
      const fault = failRename((file) => file === destination);
      try {
        await expect(installation.install(candidate, { replaceUnmarked: true })).rejects.toMatchObject({ code: 'install_health_check_failed', cause: { code: 'EIO' } });
      } finally {
        fault.restore();
      }
      expect(uninstall).not.toHaveBeenCalled();
      expect(await fs.readFile(unitPath, 'utf8')).toBe('operator unit');
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');
      await expectUninstalled();
    });

    it('keeps a lease release failure beside a removal failure in install cleanup (#1991)', async () => {
      installation = migrating();
      await verdicts('migration-required');
      const releaseError = new Error('injected release failure');
      const removalError = new Error('injected record removal failure');
      const original = daemonOwner.acquireDaemonOwner;
      const leaseFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      const record = path.join(storeDir, 'service', 'installation.json');
      const rename = failRename((file) => file === record);
      const originalRm = fs.rm.bind(fs);
      const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (String(target) === record) throw removalError;
        return originalRm(target, options);
      });
      const error = await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught).finally(() => { rename.restore(); rm.mockRestore(); leaseFault.mockRestore(); });
      expect(error).toMatchObject({ code: 'install_health_check_failed', cause: { errors: [expect.objectContaining({ code: 'EIO' }), removalError, releaseError] } });
    });

    it('removes the marked unit after a failed preparation restore, so no boot or login starts it on partial stores', async () => {
      const unitPath = path.join(root, 'service.unit');
      const launcherPath = path.join(root, 'service.launcher');
      const unitEvents: string[] = [];
      let running = true;
      const removalError = new Error('injected unit removal failure');
      let removalFails = true;
      const def = { name: 'svc', storeDir, logDir: path.join(storeDir, 'service-logs'), owner: 'app', program: { command: process.execPath, args: [] } };
      const unit: PlatformUnit = {
        serviceName: 'svc', unitPath, launcherPath,
        files: () => [unitPath, launcherPath].map((file) => ({ path: file, content: SERVICE_UNIT_MARKER })),
        activate: async () => { unitEvents.push('activate'); }, deactivate: async () => { unitEvents.push('deactivate'); running = false; },
        removeFiles: async () => { unitEvents.push('remove'); if (removalFails) throw removalError; for (const file of [unitPath, launcherPath]) await fs.rm(file); },
        start: async () => { unitEvents.push('start'); running = true; }, stop: async () => { unitEvents.push('stop'); running = false; },
        query: async () => ({ running, determinate: true, detail: 'fake' }),
      };
      for (const file of [unitPath, launcherPath]) await fs.writeFile(file, SERVICE_UNIT_MARKER);
      installation = installationOver(createManagedLifecycle(def, unit), {
        migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] }),
      });
      await verdicts('migration-required');
      const fault = failRestore();
      try {
        // A removal that fails too names both the unit and the kept snapshot (#1991).
        const failed = await installation.install(await payload('2.0.0', { 'migrate.cjs': `${MIGRATE}\nprocess.exit(1);` })).catch((caught: unknown) => caught);
        expect((failed as AggregateError).errors).toEqual([expect.any(AggregateError), removalError]);
        expect((failed as Error).message).toContain(unitPath);
        expect((failed as Error).message).toContain(path.join(installRoot, 'snapshots', '.install-repair-'));
        expect(existsSync(unitPath)).toBe(true);
        expect(unitEvents).toContain('remove');
        // The retry refuses on the kept repair snapshot (its restore still fails) and removes the unit then.
        removalFails = false;
        await expect(installation.install(await payload('2.0.0', { 'migrate.cjs': `${MIGRATE}\nprocess.exit(1);` }))).rejects.toThrow('The stores of an earlier failed install were not restored');
      } finally {
        fault.restore();
      }
      expect(unitEvents).not.toContain('start');
      expect(unitEvents).toContain('remove');
      expect(existsSync(unitPath) || existsSync(launcherPath)).toBe(false);
      expect(await snapshotNames()).toEqual([expect.stringMatching(/^\.install-repair-/u)]);
    });

    it('keeps a failed preparation restore for repair, starts nothing, and the next first install restores it before its precheck', async () => {
      const migrate: ServiceInstallationOptions['migrate'] = (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'accepted'] });
      installation = installationOver(fakeLifecycle(), { migrate });
      await verdicts('migration-required');
      const fault = failRestore();
      const candidate = await payload('2.0.0', { 'migrate.cjs': `${MIGRATE}\nprocess.exit(1);` });
      let error: unknown;
      try {
        error = await installation.install(candidate).catch((caught: unknown) => caught);
      } finally {
        fault.restore();
      }
      const [repair] = await snapshotNames();
      expect(await snapshotNames()).toEqual([expect.stringMatching(/^\.install-repair-/u)]);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ errors: [expect.objectContaining({ code: 'store_migration_failed' }), fault.restoreError] });
      expect((error as Error).message).toContain(path.join(installRoot, 'snapshots', repair!));
      expect(events).toEqual(['stop', 'uninstall']);
      expect(existsSync(db)).toBe(false);
      await expect(fs.lstat(path.join(installRoot, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);

      // A retry that cannot quiesce before the repair restore starts nothing either.
      const stopError = new Error('marked service stop failed');
      installation = installationOver({ ...fakeLifecycle(), stop: async () => { events.push('stop'); throw stopError; } }, { migrate });
      events = [];
      const stopped = await installation.install(candidate).catch((caught: unknown) => caught);
      expect(stopped).toMatchObject({ errors: [stopError] });
      expect((stopped as Error).message).toContain(path.join(installRoot, 'snapshots', repair!));
      expect(events).toEqual(['stop', 'uninstall']);
      expect(await snapshotNames()).toEqual([repair]);
      expect(existsSync(db)).toBe(false);

      // A restore whose repair name cannot be retired starts nothing either.
      installation = installationOver(fakeLifecycle(), { migrate });
      events = [];
      const retire = failRename((file) => path.dirname(file) === path.join(installRoot, 'snapshots'));
      let unretired: unknown;
      try {
        unretired = await installation.install(candidate).catch((caught: unknown) => caught);
      } finally {
        retire.restore();
      }
      expect(retire.fired()).toBe(true);
      expect((unretired as Error).message).toContain(path.join(installRoot, 'snapshots', repair!));
      expect(events).toEqual(['stop', 'uninstall']);
      expect(await snapshotNames()).toEqual([repair]);

      // A retry whose repair restore fails again changes nothing else and starts nothing.
      await verdicts('accepted');
      const seen: boolean[] = [];
      installation = installationOver(fakeLifecycle(), {
        migrate,
        precheck: (versionDir) => {
          seen.push(existsSync(db));
          return { command: process.execPath, args: [path.join(versionDir, 'precheck.cjs'), path.join(root, 'verdicts.json')] };
        },
      });
      events = [];
      const again = failRestore();
      try {
        const retry = await installation.install(candidate).catch((caught: unknown) => caught);
        expect(retry).toBeInstanceOf(AggregateError);
        expect((retry as Error).message).toContain(path.join(installRoot, 'snapshots', repair!));
      } finally {
        again.restore();
      }
      expect(seen).toEqual([]);
      expect(events).toEqual(['stop', 'uninstall']);
      expect(await snapshotNames()).toEqual([repair]);
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);

      events = [];
      await installation.install(candidate);
      expect(seen).toEqual([true]);
      expect(events).toEqual(['stop', 'install', 'start', 'health 2.0.0']);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
      expect(await fs.readFile(`${db}-wal`, 'utf8')).toBe('v1 wal');
      expect(await pointer('current')).toBe('2.0.0');
      expect(await snapshotNames()).toEqual([]);
    });

    it('restores the stores only after every installation artifact is removed, and keeps a failed restore for repair', async () => {
      installation = migrating();
      await verdicts('migration-required');
      unhealthy.add('2.0.0');
      let healthFailed = false;
      onHealth = async () => { healthFailed = true; };
      const fault = failRestore(() => healthFailed);
      // The restore's own lease then fails to release too: neither error may hide the other.
      const releaseError = new Error('injected release failure');
      const original = daemonOwner.acquireDaemonOwner;
      const faulty: typeof original = async (...args) => {
        const lease = await original(...args);
        return healthFailed ? { release: async () => { await lease.release(); throw releaseError; } } : lease;
      };
      const leaseFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(faulty);
      let error: unknown;
      try {
        error = await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught);
      } finally {
        fault.restore();
        leaseFault.mockRestore();
      }
      const [repair] = await snapshotNames();
      expect(await snapshotNames()).toEqual([expect.stringMatching(/^\.install-repair-/u)]);
      expect(error).toMatchObject({ code: 'install_health_check_failed' });
      // One flat cause: the health failure, the restore error, then the release failure (#1991).
      expect(((error as Error).cause as AggregateError).errors).toEqual([expect.anything(), expect.objectContaining({ errors: [fault.restoreError] }), releaseError]);
      expect((error as Error).message).toContain('Remaining: prepared store snapshot restoration, store lease release, install snapshot directory.');
      expect((error as Error).message).toContain(path.join(installRoot, 'snapshots', repair!));
      expect(events.slice(-2)).toEqual(['health 2.0.0', 'uninstall']);
      expect(await pointer('current')).toBeUndefined();
      expect(await readServiceInstallationRecord(storeDir)).toBeUndefined();
      expect(await fs.readdir(path.join(installRoot, 'versions'))).toEqual([]);

      // The retry restores the repair; its cleanup restore fails again but its leases are released: not remaining (#1991).
      healthFailed = false;
      const again = failRestore(() => healthFailed);
      const restoreOnly = await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught).finally(() => again.restore());
      expect((restoreOnly as Error).message).toContain('Remaining: prepared store snapshot restoration, install snapshot directory.');

      // The next retry restores the repair; its own cleanup restore succeeds and only the release fails (#1991).
      healthFailed = false;
      const retry = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(faulty);
      const released = await installation.install(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught).finally(() => retry.mockRestore());
      const [leftover] = await snapshotNames();
      expect((released as Error).message).toContain('Remaining: store lease release, install snapshot directory.');
      expect((released as Error).message).toContain(`The stores were restored; remove the install snapshot at ${path.join(installRoot, 'snapshots', leftover!)}`);
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });

    it('same-id install skips preparation and preserves an earlier upgrade snapshot and rollback', async () => {
      await installation.install(await payload('1.0.0'));
      await installation.upgrade(await payload('2.0.0'));
      const before = await tree(path.join(installRoot, 'snapshots', '2.0.0'));
      await fs.writeFile(db, 'v2 data');
      installation = installationOver(fakeLifecycle(), {
        precheck: () => { throw new Error('same-id repair must not prepare stores'); },
        migrate: () => { throw new Error('same-id repair must not migrate stores'); },
      });
      await installation.install(await payload('2.0.0'));
      expect(await tree(path.join(installRoot, 'snapshots', '2.0.0'))).toEqual(before);
      expect(await installation.rollback()).toMatchObject({ state: 'rolled-back', from: '1.0.0' });
      expect(await fs.readFile(db, 'utf8')).toBe('v1 data');
    });
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

      // A lease release that fails after the restore joins the store error; the receipt keeps its code (#1991).
      await verdicts('migration-required');
      const releaseError = new Error('injected release failure');
      const original = daemonOwner.acquireDaemonOwner;
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      const released = await installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught);
      expect(released).toMatchObject({ code: 'store_migration_failed', cause: { errors: [expect.objectContaining({ code: 'store_migration_failed' }), releaseError] } });
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_migration_failed' });

      // A migrate callback that throws is store_migration_failed with that cause: a failed receipt, the old version restarted (#1984).
      await verdicts('migration-required');
      events = [];
      const setupError = new Error('no migration program');
      const throwing = installationOver(fakeLifecycle(), { migrate: () => { throw setupError; } });
      await expect(throwing.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE }))).rejects.toMatchObject({ code: 'store_migration_failed', cause: setupError });
      expect(events).toEqual(['stop', 'start']);
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_migration_failed' });

      // A restore that fails may leave partial stores (#1987): nothing starts, the receipt stays pending for recover().
      await verdicts('migration-required');
      events = [];
      const fault = failRestore();
      const error = await installation.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((cause: unknown) => cause).finally(() => fault.restore());
      expect(error).toMatchObject({ errors: [expect.objectContaining({ code: 'store_migration_failed' }), fault.restoreError] });
      expect((error as Error).message).toContain('recover()');
      expect(events).toEqual(['stop']);
      expect(await installation.receipt()).toMatchObject({ state: 'pending', from: '1.0.0', to: '2.0.0' });
      expect(await installation.recover()).toMatchObject({ state: 'rolled-back', from: '1.0.0', code: 'upgrade_pending' });
      expect([await fs.readFile(db, 'utf8'), await fs.readFile(`${db}-wal`, 'utf8')]).toEqual(['v1 data', 'v1 wal']);

      // The failed receipt cannot be written, with or without a release failure: the receipt stays pending, so the
      // previous version stays stopped and recover() restores the snapshot under nothing the service wrote (#1991).
      const receiptPath = path.join(installRoot, 'upgrade-receipt.json');
      for (const releaseFails of [false, true]) {
        await verdicts('migration-required');
        const written: string[] = [];
        const base = fakeLifecycle();
        const writing = installationOver({ ...base, start: async () => {
          await base.start();
          written.push(`write ${written.length}`);
          await fs.appendFile(db, `\n${written.at(-1)!}`);
        } }, {
          migrate: (versionDir) => ({ command: process.execPath, args: [path.join(versionDir, 'migrate.cjs'), path.join(root, 'verdicts.json'), db, 'migration-required'] }),
        });
        const releaseError = new Error('injected release failure');
        const original = daemonOwner.acquireDaemonOwner;
        const leaseFault = releaseFails ? vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
          const lease = await original(...args);
          return { release: async () => { await lease.release(); throw releaseError; } };
        }) : undefined;
        let receiptWrites = 0;
        const receiptFault = failRename((file) => file === receiptPath && ++receiptWrites === 2);
        events = [];
        const failed = await writing.upgrade(await payload('2.0.0', { 'migrate.cjs': MIGRATE })).catch((caught: unknown) => caught)
          .finally(() => { receiptFault.restore(); leaseFault?.mockRestore(); });
        expect(failed).toMatchObject({ code: releaseFails ? 'store_release_failed' : 'store_migration_failed' });
        expect(events).not.toContain('start');
        expect(await writing.receipt()).toMatchObject({ state: 'pending' });
        await writing.recover();
        const data = await fs.readFile(db, 'utf8');
        for (const line of written) expect(data).toContain(line);
      }
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
    const both = (extra: Partial<ServiceInstallationOptions> = {}) => installationOver(fakeLifecycle(), {
      daemonStores: async () => [{ storeDir, productId: 'svc' }, { storeDir: research, productId: 'research' }],
      ...extra,
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
      // Before the switched receipt: store_release_failed, the receipt stays pending (#1991).
      const switched = await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught);
      expect(switched).toBeInstanceOf(ServiceInstallationError);
      expect(switched).toMatchObject({ code: 'store_release_failed', cause: { errors: [expect.objectContaining({ message: 'injected release failure' })] } });
      expect((switched as Error).message).toContain('recover()');
      expect(await installation.receipt()).toMatchObject({ state: 'pending', from: '1.0.0', to: '2.0.0' });
      await expect(fs.access(path.join(research, 'daemon-owner.json'))).rejects.toThrow();

      // recover() runs into the same release failure before its final receipt; the receipt stays pending.
      const recoverFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw new Error('injected recover release failure'); } };
      });
      await expect(installation.recover()).rejects.toMatchObject({ code: 'store_release_failed' });
      recoverFault.mockRestore();
      expect(await installation.receipt()).toMatchObject({ state: 'pending' });

      // A lease that stays held after its release failed keeps this process store_busy: recover() cannot take it
      // until that process exits, so the Host restarts before recover().
      let stuck: daemonOwner.DaemonOwnerLease | undefined;
      const holdFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        stuck = await original(...args);
        return { release: async () => { throw new Error('lease left held'); } };
      });
      const short = both({ stopTimeoutMs: 100 });
      await expect(short.recover()).rejects.toMatchObject({ code: 'store_release_failed' });
      holdFault.mockRestore();
      await expect(short.recover()).rejects.toMatchObject({ code: 'store_busy' });
      await stuck!.release();
      await expect(short.recover()).resolves.toMatchObject({ state: 'rolled-back' });

      // A refusal after both leases whose leases both fail to release carries every release failure (#1991).
      await installation.recover();
      const releaseErrors = [new Error('first release failure'), new Error('second release failure')];
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockRestore();
      const real = daemonOwner.acquireDaemonOwner;
      let taken = 0;
      const leaseFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(async (...args) => {
        const lease = await real(...args);
        const releaseError = releaseErrors[taken++];
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      const residue = vi.spyOn(OwnedProcessLedger.prototype, 'reconcile').mockRejectedValueOnce(new OwnedProcessResidueError({ survived: 1 } as OwnedProcessReconciliation, ['record']));
      const error = await installation.upgrade(await payload('3.0.0')).catch((caught: unknown) => caught).finally(() => { leaseFault.mockRestore(); residue.mockRestore(); });
      expect(error).toBeInstanceOf(ServiceInstallationError);
      expect(error).toMatchObject({ code: 'owned_process_residue', cause: { errors: [expect.objectContaining({ code: 'owned_process_residue' }), ...releaseErrors] } });

      // A failed health check whose rollback then fails to release: store_release_failed with the health failure in its cause.
      unhealthy.add('4.0.0');
      const rollbackRelease = new Error('rollback release failure');
      let acquired = 0;
      const rollbackFault = vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(async (...args) => {
        const lease = await real(...args);
        // Leases 0 and 1 are the upgrade's own; lease 2 is the rollback's first.
        return acquired++ === 2 ? { release: async () => { await lease.release(); throw rollbackRelease; } } : lease;
      });
      const unhealthyError = await installation.upgrade(await payload('4.0.0')).catch((caught: unknown) => caught).finally(() => rollbackFault.mockRestore());
      expect(unhealthyError).toMatchObject({ code: 'store_release_failed', cause: { errors: [expect.objectContaining({ code: 'health_check_failed' }), rollbackRelease] } });
      expect(await installation.receipt()).toMatchObject({ state: 'pending', to: '4.0.0' });
    });

    it('a release failure while the receipt stays pending is store_release_failed with one flat cause (#1991)', async () => {
      installation = both();
      await installation.install(await payload('1.0.0'));
      const releaseError = new Error('injected release failure');
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockRestore();
      const real = daemonOwner.acquireDaemonOwner;
      /** Fails the release of the lease taken `at` (0-based) from now on. */
      const faultAt = (at: number) => {
        let taken = 0;
        return vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementation(async (...args) => {
          const lease = await real(...args);
          return taken++ === at ? { release: async () => { await lease.release(); throw releaseError; } } : lease;
        });
      };
      const current = path.join(installRoot, 'current');
      const expectPendingRelease = async (error: unknown, first: object[]) => {
        expect(error).toBeInstanceOf(ServiceInstallationError);
        expect(error).toMatchObject({ code: 'store_release_failed', cause: { errors: [...first.map((item) => expect.objectContaining(item)), releaseError] } });
        expect(await installation.receipt()).toMatchObject({ state: 'pending' });
        await installation.recover();
      };

      // (a) A pointer write fails on upgrade, then on rollback.
      let leases = faultAt(0);
      let rename = failRename((file) => file === current);
      await expectPendingRelease(await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught).finally(() => { rename.restore(); leases.mockRestore(); }), [{ code: 'EIO' }]);
      await installation.upgrade(await payload('2.0.0'));
      leases = faultAt(0);
      rename = failRename((file) => file === current);
      await expectPendingRelease(await installation.rollback().catch((caught: unknown) => caught).finally(() => { rename.restore(); leases.mockRestore(); }), [{ code: 'EIO' }]);

      // The rollback after a failed health check: health_check_failed first, then its pointer write, then the release.
      unhealthy.add('3.0.0');
      let writes = 0;
      leases = faultAt(2);
      rename = failRename((file) => file === current && ++writes === 2);
      await expectPendingRelease(await installation.upgrade(await payload('3.0.0')).catch((caught: unknown) => caught).finally(() => { rename.restore(); leases.mockRestore(); }), [{ code: 'health_check_failed' }, { code: 'EIO' }]);

      // (b) A preparation error that is not a ServiceInstallationError writes no failed receipt.
      const precheckError = new Error('injected precheck setup failure');
      const raw = installationOver(fakeLifecycle(), {
        daemonStores: async () => [{ storeDir, productId: 'svc' }, { storeDir: research, productId: 'research' }],
        precheck: () => { throw precheckError; },
      });
      leases = faultAt(0);
      await expectPendingRelease(await raw.upgrade(await payload('4.0.0')).catch((caught: unknown) => caught).finally(() => leases.mockRestore()), [{ message: precheckError.message }]);
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

      // The lease already taken that then fails to release joins store_busy; the receipt keeps its code (#1991).
      const busy = await acquireDaemonOwner(research, 'daemon');
      const releaseError = new Error('injected release failure');
      const original = daemonOwner.acquireDaemonOwner;
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      const error = await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught).finally(() => busy.release());
      expect(error).toBeInstanceOf(ServiceInstallationError);
      expect(error).toMatchObject({ code: 'store_busy', cause: { errors: [expect.objectContaining({ code: 'store_busy' }), releaseError] } });
      expect(await installation.receipt()).toMatchObject({ state: 'failed', code: 'store_busy' });

      // A restart that fails after the refusal joins it; the refusal keeps its class and code (#1991).
      const startError = new Error('injected start failure');
      const stillBusy = await acquireDaemonOwner(research, 'daemon');
      const failingStart = installationOver({ ...fakeLifecycle(), start: async () => { throw startError; } }, {
        daemonStores: async () => [{ storeDir, productId: 'svc' }, { storeDir: research, productId: 'research' }],
        stopTimeoutMs: 100,
      });
      const restartFailed = await failingStart.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught).finally(() => stillBusy.release());
      expect(restartFailed).toBeInstanceOf(ServiceInstallationError);
      expect(restartFailed).toMatchObject({ code: 'store_busy', cause: { errors: [expect.objectContaining({ code: 'store_busy' }), startError] } });

      // (c) store_busy, its lease release fails, then the failed receipt cannot be written: the receipt stays pending.
      const stuckBusy = await acquireDaemonOwner(research, 'daemon');
      vi.spyOn(daemonOwner, 'acquireDaemonOwner').mockImplementationOnce(async (...args) => {
        const lease = await original(...args);
        return { release: async () => { await lease.release(); throw releaseError; } };
      });
      const receiptPath = path.join(installRoot, 'upgrade-receipt.json');
      let receiptWrites = 0;
      const receiptFault = failRename((file) => file === receiptPath && ++receiptWrites === 2);
      const pendingBusy = await installation.upgrade(await payload('2.0.0')).catch((caught: unknown) => caught).finally(() => { receiptFault.restore(); return stuckBusy.release(); });
      expect(pendingBusy).toBeInstanceOf(ServiceInstallationError);
      expect(pendingBusy).toMatchObject({ code: 'store_release_failed', cause: { errors: [expect.objectContaining({ code: 'store_busy' }), releaseError, expect.objectContaining({ code: 'EIO' })] } });
      expect(await installation.receipt()).toMatchObject({ state: 'pending' });
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
