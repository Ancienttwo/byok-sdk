import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readServiceInstallationRecord,
  serviceInstallationOver,
  ServiceInstallationError,
  SERVICE_PAYLOAD_MANIFEST,
  type ServiceInstallation,
} from '../lifecycle/service-installation';
import type { ServiceLifecycle } from '../lifecycle/service-types';
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

function fakeLifecycle(): ServiceLifecycle {
  const record = (event: string) => async () => { events.push(event); };
  return {
    install: record('install'), uninstall: record('uninstall'), start: record('start'), stop: record('stop'),
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
  installation = serviceInstallationOver({
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
  }, fakeLifecycle());
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
});
