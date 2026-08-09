import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonConfig, RuntimeAdapter } from '../index';
import { connectControlClient } from '../bin/control-client';
import { defaultRuntimeAdapters, probeRuntimes } from '../bin/runtime-probe';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { JOURNAL_DB_FILENAME, JOURNAL_QUARANTINE_DIRNAME } from '../daemon/journal/sqlite-journal';
import { isSqliteAvailable, loadSqliteModule } from '../daemon/journal/sqlite-support';
import {
  inspectOperationalHealthHandle,
  inspectOperationalHealthFile,
  MAX_OPERATIONAL_HEALTH_FILE_BYTES,
  type OperationalHealthFileInspection,
  OPERATIONAL_HEALTH_FILENAME,
} from '../daemon/operational-health';
import { acquireDaemonOwner } from '../daemon/daemon-owner';
import { ensureSecureDir } from '../util/secure-dir';

export const MAX_QUARANTINE_ENTRIES = 100;
export const MAX_QUARANTINE_SCAN_ENTRIES = 10_000;
export const MAX_DEVICE_RECORD_BYTES = 64 * 1024;
export const MAX_JOURNAL_COPY_BYTES = 512 * 1024 * 1024;
const MAX_QUARANTINE_MANIFEST_BYTES = 64 * 1024;

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: 'config' | 'device' | 'runtimes' | 'control' | 'health' | 'journal' | 'workspace' | 'quarantine';
  status: DiagnosticStatus;
  summary: string;
}

export interface DiagnosticsSnapshot {
  version: 1;
  generatedAt: string;
  product: { nameHash: string; idHash: string };
  system: { node: string; platform: NodeJS.Platform; arch: string; sqliteAvailable: boolean };
  config: {
    serverProtocol: 'http' | 'https' | 'ws' | 'wss' | 'invalid' | 'unsupported';
    customStoreDir: boolean;
    hostedJournal: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: 'paired' | 'unpaired' | 'unavailable'; deviceIdHash?: string };
  runtimes: Array<{
    idHash: string;
    present: boolean;
    versionPresent: boolean;
    authPresent?: boolean;
    steer: boolean;
    resume: boolean;
    permissionModeCount: number;
  }>;
  control:
    | { status: 'offline'; reason: string }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        transport: string;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        storage?: ControlStatusResult['storage'];
      };
  health: OperationalHealthFileInspection;
  journal: {
    status: 'missing' | 'present' | 'corrupt' | 'unavailable';
    sizeBytes?: number;
    walBytes?: number;
    integrity?: 'ok' | 'not-checked';
    reason?: string;
  };
  workspace: { status: 'available' | 'missing' | 'unavailable'; writable?: boolean; reason?: string };
  quarantine: {
    status: 'available' | 'missing' | 'unavailable';
    count: number;
    scannedCount: number;
    truncated: boolean;
    entries: Array<{ nameHash: string; sizeBytes: number; modifiedAt: string }>;
    reason?: string;
  };
  checks: DiagnosticCheck[];
}

export interface CollectDiagnosticsOptions {
  clock?: () => Date;
  adapters?: RuntimeAdapter[];
  connectControl?: typeof connectControlClient;
  runtimeProbeTimeoutMs?: number;
}

export type OperationalHealthFixResult =
  | { status: 'not-needed'; reason: 'missing' | 'valid' }
  | { status: 'quarantined'; evidenceName: string; manifestName: string; sha256: string; sizeBytes: number };

function safeProtocol(serverUrl: string): DiagnosticsSnapshot['config']['serverProtocol'] {
  try {
    const protocol = new URL(serverUrl).protocol.replace(/:$/, '');
    return protocol === 'http' || protocol === 'https' || protocol === 'ws' || protocol === 'wss' ? protocol : 'unsupported';
  } catch {
    return 'invalid';
  }
}

async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function inspectDevice(storeDir: string): Promise<DiagnosticsSnapshot['device']> {
  const filePath = path.join(storeDir, 'device.json');
  try {
    const pathStat = await fs.lstat(filePath);
    if (!pathStat.isFile()) return { status: 'unavailable' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unpaired' };
    return { status: 'unavailable' };
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unpaired' };
    return { status: 'unavailable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DEVICE_RECORD_BYTES) return { status: 'unavailable' };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      return { status: 'unavailable' };
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0
      ? { status: 'paired', deviceIdHash: stableIdentifierHash(parsed.deviceId) }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    await handle.close();
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function regularFileIdentity(filePath: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile()) throw new Error('journal component is not a regular file');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identityFromBigIntStat(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

async function copyOpenFileBounded(
  source: Awaited<ReturnType<typeof fs.open>>,
  expected: FileIdentity,
  destinationPath: string,
): Promise<boolean> {
  const destination = await fs.open(destinationPath, 'wx', 0o600);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const expectedBytes = Number(expected.size);
    let position = 0;
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead === 0) return false;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error('diagnostics snapshot destination stopped accepting bytes');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.sync();
    return sameIdentity(expected, identityFromBigIntStat(await source.stat({ bigint: true })));
  } finally {
    await destination.close();
  }
}

async function inspectJournal(storeDir: string): Promise<DiagnosticsSnapshot['journal']> {
  const journalPath = path.join(storeDir, JOURNAL_DB_FILENAME);
  try {
    const mainIdentity = await regularFileIdentity(journalPath);
    if (mainIdentity === undefined) return { status: 'missing' };
    const walIdentity = await regularFileIdentity(path.join(storeDir, `${JOURNAL_DB_FILENAME}-wal`));
    let sizeBytes = Number(mainIdentity.size);
    let walBytes = walIdentity === undefined ? undefined : Number(walIdentity.size);
    if (!isSqliteAvailable()) {
      return { status: 'present', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), integrity: 'not-checked' };
    }
    const componentNames = [JOURNAL_DB_FILENAME, `${JOURNAL_DB_FILENAME}-wal`, `${JOURNAL_DB_FILENAME}-shm`] as const;
    const initial = new Map<string, FileIdentity | undefined>();
    for (const name of componentNames) initial.set(name, await regularFileIdentity(path.join(storeDir, name)));
    const snapshotMain = initial.get(JOURNAL_DB_FILENAME);
    if (!snapshotMain) return { status: 'unavailable', reason: 'journal changed during diagnostics snapshot' };
    sizeBytes = Number(snapshotMain.size);
    walBytes = initial.get(`${JOURNAL_DB_FILENAME}-wal`) === undefined
      ? undefined
      : Number(initial.get(`${JOURNAL_DB_FILENAME}-wal`)!.size);
    const opened = new Map<string, { handle: Awaited<ReturnType<typeof fs.open>>; identity: FileIdentity }>();
    let totalBytes = 0n;
    try {
      for (const name of componentNames) {
        let handle: Awaited<ReturnType<typeof fs.open>>;
        try {
          handle = await fs.open(
            path.join(storeDir, name),
            fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' && name !== JOURNAL_DB_FILENAME) continue;
          throw err;
        }
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile()) {
          await handle.close();
          throw new Error('journal component is not a regular file');
        }
        const identity = identityFromBigIntStat(stat);
        if (!sameIdentity(initial.get(name), identity)) {
          await handle.close();
          return { status: 'unavailable', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal changed during diagnostics snapshot' };
        }
        totalBytes += identity.size;
        opened.set(name, { handle, identity });
      }
      if (totalBytes > BigInt(MAX_JOURNAL_COPY_BYTES)) {
        return {
          status: 'present',
          sizeBytes,
          ...(walBytes === undefined ? {} : { walBytes }),
          integrity: 'not-checked',
          reason: 'journal exceeds the bounded diagnostics copy limit',
        };
      }
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-journal-inspect-'));
      const { DatabaseSync } = loadSqliteModule();
      let db: InstanceType<typeof DatabaseSync> | undefined;
      try {
        for (const name of componentNames) {
          const component = opened.get(name);
          if (component && !(await copyOpenFileBounded(component.handle, component.identity, path.join(tempDir, name)))) {
            return { status: 'unavailable', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal changed during diagnostics snapshot' };
          }
        }
        for (const [name, component] of opened) {
          if (
            !sameIdentity(component.identity, identityFromBigIntStat(await component.handle.stat({ bigint: true }))) ||
            !sameIdentity(component.identity, await regularFileIdentity(path.join(storeDir, name)))
          ) {
            return { status: 'unavailable', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal changed during diagnostics snapshot' };
          }
        }
        for (const name of componentNames) {
          if (!opened.has(name) && (await regularFileIdentity(path.join(storeDir, name))) !== undefined) {
            return { status: 'unavailable', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal changed during diagnostics snapshot' };
          }
        }
        const header = Buffer.alloc(16);
        const copiedHandle = await fs.open(path.join(tempDir, JOURNAL_DB_FILENAME), 'r');
        try {
          const { bytesRead } = await copiedHandle.read(header, 0, header.length, 0);
          if (bytesRead !== 16 || header.toString('binary') !== 'SQLite format 3\u0000') {
            return { status: 'corrupt', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal has an invalid SQLite header' };
          }
        } finally {
          await copiedHandle.close();
        }
        db = new DatabaseSync(path.join(tempDir, JOURNAL_DB_FILENAME), { readOnly: true });
        const result = db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: unknown } | undefined;
        if (result?.quick_check !== 'ok') {
          return { status: 'corrupt', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal quick_check failed' };
        }
        return { status: 'present', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), integrity: 'ok' };
      } catch {
        return { status: 'unavailable', sizeBytes, ...(walBytes === undefined ? {} : { walBytes }), reason: 'journal snapshot could not be checked' };
      } finally {
        db?.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } finally {
      await Promise.all([...opened.values()].map(({ handle }) => handle.close().catch(() => undefined)));
    }
  } catch {
    return { status: 'unavailable', reason: 'journal files could not be inspected' };
  }
}

async function inspectWorkspace(workspaceRoot: string): Promise<DiagnosticsSnapshot['workspace']> {
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) return { status: 'unavailable', reason: 'workspace root is not a directory' };
    try {
      await fs.access(workspaceRoot, fsConstants.R_OK | fsConstants.W_OK);
      return { status: 'available', writable: true };
    } catch {
      return { status: 'available', writable: false };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'unavailable', reason: 'workspace root could not be inspected' };
  }
}

interface PinnedQuarantineFile {
  sizeBytes: number;
  modifiedAt: string;
  bytes?: Buffer;
}

function readPinnedQuarantineFile(name: string, maxBytes: number, includeBytes: boolean): PinnedQuarantineFile {
  if (path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('quarantine manifest contains an invalid evidence name');
  }
  const namedBefore = lstatSync(name, { bigint: true });
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) {
    throw new Error('quarantine entry is not a real regular file');
  }
  const fd = openSync(name, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameInode(opened, namedBefore) || opened.size < 0 || opened.size > BigInt(maxBytes)) {
      throw new Error('quarantine entry could not be opened as a bounded regular file');
    }
    let bytes: Buffer | undefined;
    if (includeBytes) {
      bytes = Buffer.alloc(Number(opened.size));
      let position = 0;
      while (position < bytes.length) {
        const bytesRead = readSync(fd, bytes, position, bytes.length - position, position);
        if (bytesRead === 0) throw new Error('quarantine entry ended during bounded read');
        position += bytesRead;
      }
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(name, { bigint: true });
    if (!sameFileState(openedAfter, opened) || !sameFileState(namedAfter, opened)) {
      throw new Error('quarantine entry changed during inspection');
    }
    return {
      sizeBytes: Number(opened.size),
      modifiedAt: new Date(Number(opened.mtimeMs)).toISOString(),
      ...(bytes === undefined ? {} : { bytes }),
    };
  } finally {
    closeSync(fd);
  }
}

function isHealthQuarantineManifest(value: unknown): value is {
  version: 1;
  quarantinedAt: string;
  reason: string;
  sourcePath: string;
  evidenceFile: string;
  sha256: string;
  sizeBytes: number;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.quarantinedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.quarantinedAt)) &&
    typeof candidate.reason === 'string' &&
    typeof candidate.sourcePath === 'string' &&
    typeof candidate.evidenceFile === 'string' &&
    typeof candidate.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.sha256) &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    (candidate.sizeBytes as number) >= 0 &&
    (candidate.sizeBytes as number) <= MAX_OPERATIONAL_HEALTH_FILE_BYTES
  );
}

function isJournalQuarantineManifest(value: unknown): value is {
  quarantinedAt: string;
  reason: string;
  originalPath: string;
  files: string[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.quarantinedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.quarantinedAt)) &&
    typeof candidate.reason === 'string' &&
    typeof candidate.originalPath === 'string' &&
    Array.isArray(candidate.files) &&
    candidate.files.length > 0 &&
    candidate.files.length <= 3 &&
    candidate.files.every((file) => typeof file === 'string')
  );
}

function inspectQuarantinePinned(
  dir: string,
  expectedDirectory: import('node:fs').BigIntStats,
): DiagnosticsSnapshot['quarantine'] {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const pinned = lstatSync('.', { bigint: true });
    if (!pinned.isDirectory() || !sameInode(pinned, expectedDirectory)) {
      throw new Error('quarantine directory changed during inspection');
    }
    const selected: import('node:fs').Dirent[] = [];
    let scanTruncated = false;
    const directory = opendirSync('.');
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (selected.length === MAX_QUARANTINE_SCAN_ENTRIES) {
          scanTruncated = true;
          break;
        }
        selected.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    const evidence = new Map<string, PinnedQuarantineFile>();
    const processedManifests = new Set<string>();

    const processManifest = (manifestName: string): void => {
      if (processedManifests.has(manifestName)) return;
      processedManifests.add(manifestName);
      const manifestFile = readPinnedQuarantineFile(manifestName, MAX_QUARANTINE_MANIFEST_BYTES, true);
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestFile.bytes?.toString('utf8') ?? '');
      } catch {
        throw new Error('quarantine manifest is invalid JSON');
      }
      if (isHealthQuarantineManifest(parsed)) {
        if (`${parsed.evidenceFile}.manifest.json` !== manifestName) {
          throw new Error('health quarantine manifest is not bound to its evidence name');
        }
        const file = readPinnedQuarantineFile(parsed.evidenceFile, MAX_OPERATIONAL_HEALTH_FILE_BYTES, true);
        if (
          file.sizeBytes !== parsed.sizeBytes ||
          createHash('sha256').update(file.bytes ?? Buffer.alloc(0)).digest('hex') !== parsed.sha256
        ) {
          throw new Error('health quarantine evidence does not match its manifest');
        }
        if (evidence.has(parsed.evidenceFile)) throw new Error('quarantine evidence is referenced more than once');
        evidence.set(parsed.evidenceFile, file);
        return;
      }
      if (isJournalQuarantineManifest(parsed)) {
        const manifestBase = manifestName.slice(0, -'.manifest.json'.length);
        const boundNames = parsed.files.map((file) => {
          if (path.dirname(path.resolve(file)) !== path.resolve('.')) {
            throw new Error('journal quarantine manifest points outside quarantine');
          }
          return path.basename(file);
        });
        if (!boundNames.includes(manifestBase)) {
          throw new Error('journal quarantine manifest is not bound to its primary database evidence');
        }
        for (const name of boundNames) {
          if (evidence.has(name)) throw new Error('quarantine evidence is referenced more than once');
          evidence.set(name, readPinnedQuarantineFile(name, MAX_JOURNAL_COPY_BYTES, false));
        }
        return;
      }
      throw new Error('quarantine manifest shape is invalid');
    };

    for (const entry of selected) {
      if (entry.name.endsWith('.manifest.json')) processManifest(entry.name);
    }

    for (const entry of selected) {
      if (!entry.name.endsWith('.manifest.json') && !evidence.has(entry.name)) {
        const primaryName = entry.name.endsWith('-wal') || entry.name.endsWith('-shm')
          ? entry.name.slice(0, -4)
          : entry.name;
        try {
          processManifest(`${primaryName}.manifest.json`);
        } catch {
          throw new Error('quarantine evidence has no valid manifest binding');
        }
        if (!evidence.has(entry.name)) throw new Error('quarantine evidence has no valid manifest binding');
      }
    }

    const entries = [...evidence.entries()]
      .slice(0, MAX_QUARANTINE_ENTRIES)
      .map(([name, file]) => ({ nameHash: stableIdentifierHash(name), sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt }))
      .sort((a, b) => a.nameHash.localeCompare(b.nameHash));
    return {
      status: 'available',
      count: evidence.size,
      scannedCount: selected.length,
      truncated: scanTruncated || evidence.size > entries.length,
      entries,
    };
  } finally {
    process.chdir(previousCwd);
  }
}

async function inspectQuarantine(storeDir: string): Promise<DiagnosticsSnapshot['quarantine']> {
  const dir = path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME);
  let directory: import('node:fs').BigIntStats;
  try {
    directory = await fs.lstat(dir, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', count: 0, scannedCount: 0, truncated: false, entries: [] };
    }
    return {
      status: 'unavailable',
      count: 0,
      scannedCount: 0,
      truncated: false,
      entries: [],
      reason: 'quarantine directory could not be inspected',
    };
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { status: 'unavailable', count: 0, scannedCount: 0, truncated: false, entries: [], reason: 'quarantine path is not a real directory' };
  }
  try {
    return inspectQuarantinePinned(dir, directory);
  } catch {
    return { status: 'unavailable', count: 0, scannedCount: 0, truncated: false, entries: [], reason: 'quarantine manifest or evidence binding is invalid' };
  }
}

function checksFor(snapshot: Omit<DiagnosticsSnapshot, 'checks'>): DiagnosticCheck[] {
  return [
    {
      id: 'config',
      status: snapshot.config.serverProtocol === 'invalid' ? 'fail' : 'pass',
      summary: `server protocol=${snapshot.config.serverProtocol}; hostedJournal=${snapshot.config.hostedJournal}`,
    },
    {
      id: 'device',
      status: snapshot.device.status === 'unavailable' ? 'fail' : snapshot.device.status === 'unpaired' ? 'warn' : 'pass',
      summary: snapshot.device.status,
    },
    {
      id: 'runtimes',
      status: snapshot.runtimes.some((runtime) => runtime.present) ? 'pass' : 'warn',
      summary: `${snapshot.runtimes.filter((runtime) => runtime.present).length}/${snapshot.runtimes.length} present`,
    },
    {
      id: 'control',
      status: snapshot.control.status === 'online' ? 'pass' : 'warn',
      summary: snapshot.control.status === 'online' ? `online transport=${snapshot.control.transport}` : 'daemon offline',
    },
    {
      id: 'health',
      status:
        snapshot.health.status === 'corrupt' || snapshot.health.status === 'unavailable'
          ? 'fail'
          : snapshot.health.status === 'missing'
            ? 'warn'
            : 'pass',
      summary: snapshot.health.status,
    },
    {
      id: 'journal',
      status:
        snapshot.journal.status === 'unavailable' || snapshot.journal.status === 'corrupt'
          ? 'fail'
          : snapshot.journal.status === 'missing'
            ? 'warn'
            : 'pass',
      summary: snapshot.journal.status,
    },
    {
      id: 'workspace',
      status:
        snapshot.workspace.status === 'unavailable'
          ? 'fail'
          : snapshot.workspace.status === 'missing' || snapshot.workspace.writable === false
            ? 'warn'
            : 'pass',
      summary: `${snapshot.workspace.status}${snapshot.workspace.writable === false ? '; read-only' : ''}`,
    },
    {
      id: 'quarantine',
      status: snapshot.quarantine.status === 'unavailable' ? 'fail' : snapshot.quarantine.count > 0 ? 'warn' : 'pass',
      summary: `${snapshot.quarantine.count} evidence file(s)`,
    },
  ];
}

export async function collectDiagnostics(
  config: DaemonConfig,
  storeDir: string,
  options: CollectDiagnosticsOptions = {},
): Promise<DiagnosticsSnapshot> {
  const adapters = options.adapters ?? defaultRuntimeAdapters(config.runtimeAllowlist);
  const connectControl = options.connectControl ?? connectControlClient;
  const [device, probedRuntimes, health, journal, workspace, quarantine, controlConnection] = await Promise.all([
    inspectDevice(storeDir),
    probeRuntimes(adapters, { timeoutMs: options.runtimeProbeTimeoutMs }),
    inspectOperationalHealthFile(storeDir),
    inspectJournal(storeDir),
    inspectWorkspace(config.workspaceRoot),
    inspectQuarantine(storeDir),
    connectControl({ storeDir, productId: config.productId }),
  ]);
  const runtimes: DiagnosticsSnapshot['runtimes'] = probedRuntimes.map((runtime) => ({
    idHash: stableIdentifierHash(runtime.id),
    present: runtime.present,
    versionPresent: runtime.version !== undefined,
    ...(runtime.authPresent === undefined ? {} : { authPresent: runtime.authPresent }),
    steer: runtime.steer,
    resume: runtime.resume,
    permissionModeCount: runtime.permissionModes.length,
  }));

  let control: DiagnosticsSnapshot['control'];
  if (!controlConnection.ok) {
    control = { status: 'offline', reason: 'daemon control socket unavailable' };
  } else {
    try {
      const live = await controlConnection.client.request<ControlStatusResult>('status');
      control = {
        status: 'online',
        pid: live.pid,
        uptimeMs: live.uptimeMs,
        transport: live.transport,
        activeTaskCount: live.activeTasks.length,
        pendingApprovalCount: live.approvalsPending,
        operationalHealth: live.operationalHealth,
        ...(live.storage ? { storage: live.storage } : {}),
      };
    } catch {
      control = { status: 'offline', reason: 'daemon status request failed' };
    } finally {
      controlConnection.client.close();
    }
  }

  const withoutChecks: Omit<DiagnosticsSnapshot, 'checks'> = {
    version: 1,
    generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    product: { nameHash: stableIdentifierHash(config.productName), idHash: stableIdentifierHash(config.productId) },
    system: { node: process.versions.node, platform: process.platform, arch: process.arch, sqliteAvailable: isSqliteAvailable() },
    config: {
      serverProtocol: safeProtocol(config.serverUrl),
      customStoreDir: config.storeDir !== undefined,
      hostedJournal: config.hostedJournal !== undefined,
      ...(config.runtimeAllowlist ? { runtimeAllowlistCount: config.runtimeAllowlist.length } : {}),
    },
    device,
    runtimes,
    control,
    health,
    journal,
    workspace,
    quarantine,
  };
  return { ...withoutChecks, checks: checksFor(withoutChecks) };
}

export function stableIdentifierHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameInode(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Run the destructive publication against a cwd-pinned directory inode. Node
 * does not expose openat/linkat; a checked `process.chdir()` plus a fully
 * synchronous callback is the only cross-platform way to prevent the known
 * `quarantine/` pathname from being swapped to a symlink between validation
 * and link creation. No event-loop callback can observe the temporary cwd.
 */
function publishQuarantineEvidencePinned(
  quarantineDir: string,
  expectedDirectory: import('node:fs').BigIntStats,
  sourcePath: string,
  sourceFd: number,
  sourceStat: import('node:fs').BigIntStats,
  evidenceName: string,
  manifestName: string,
  quarantinedAt: string,
  reason: string,
): { sha256: string; sizeBytes: number } {
  const previousCwd = process.cwd();
  let entered = false;
  let evidenceCreated = false;
  let sourceRemoved = false;
  let evidenceTemp: string | undefined;
  let manifestTemp: string | undefined;
  try {
    process.chdir(quarantineDir);
    entered = true;
    const pinned = lstatSync('.', { bigint: true });
    if (!pinned.isDirectory() || !sameInode(pinned, expectedDirectory)) {
      throw new Error('quarantine path changed before publication; refusing quarantine');
    }
    const openSource = fstatSync(sourceFd, { bigint: true });
    const namedSource = lstatSync(sourcePath, { bigint: true });
    if (!sameFileState(openSource, sourceStat) || !sameFileState(namedSource, sourceStat)) {
      throw new Error('operational health source identity changed before quarantine');
    }
    const sizeBytes = Number(sourceStat.size);
    if (sizeBytes > MAX_OPERATIONAL_HEALTH_FILE_BYTES) {
      throw new Error('operational health state exceeds the bounded quarantine read limit');
    }
    const bytes = Buffer.alloc(sizeBytes);
    let position = 0;
    while (position < sizeBytes) {
      const bytesRead = readSync(sourceFd, bytes, position, sizeBytes - position, position);
      if (bytesRead === 0) throw new Error('operational health state ended during bounded copy');
      position += bytesRead;
    }
    const afterRead = fstatSync(sourceFd, { bigint: true });
    if (!sameFileState(afterRead, sourceStat)) {
      throw new Error('operational health state changed during bounded copy');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    evidenceTemp = `.${evidenceName}.${randomUUID()}.tmp`;
    const evidenceFd = openSync(evidenceTemp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeFileSync(evidenceFd, bytes);
      fchmodSync(evidenceFd, 0o600);
      fsyncSync(evidenceFd);
    } finally {
      closeSync(evidenceFd);
    }
    linkSync(evidenceTemp, evidenceName);
    evidenceCreated = true;
    const evidence = lstatSync(evidenceName, { bigint: true });
    const tempEvidence = lstatSync(evidenceTemp, { bigint: true });
    if (!evidence.isFile() || !sameInode(evidence, tempEvidence) || evidence.size !== sourceStat.size) {
      throw new Error('quarantined operational health evidence does not match the bounded copy');
    }
    unlinkSync(evidenceTemp);
    evidenceTemp = undefined;
    const finalOpenSource = fstatSync(sourceFd, { bigint: true });
    const finalNamedSource = lstatSync(sourcePath, { bigint: true });
    if (!sameFileState(finalOpenSource, sourceStat) || !sameFileState(finalNamedSource, sourceStat)) {
      throw new Error('operational health source changed before removal');
    }
    unlinkSync(sourcePath);
    sourceRemoved = true;
    fchmodSync(sourceFd, 0o600);

    const manifestBody = `${JSON.stringify(
      {
        version: 1,
        quarantinedAt,
        reason,
        sourcePath,
        evidenceFile: evidenceName,
        sha256,
        sizeBytes,
      },
      null,
      2,
    )}\n`;
    manifestTemp = `.${manifestName}.${randomUUID()}.tmp`;
    const manifestFd = openSync(manifestTemp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeFileSync(manifestFd, manifestBody, 'utf8');
      fchmodSync(manifestFd, 0o600);
      fsyncSync(manifestFd);
    } finally {
      closeSync(manifestFd);
    }
    linkSync(manifestTemp, manifestName);
    unlinkSync(manifestTemp);
    manifestTemp = undefined;
    if (process.platform !== 'win32') {
      const directoryFd = openSync('.', fsConstants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    return { sha256, sizeBytes };
  } catch (err) {
    if (evidenceTemp) {
      try { unlinkSync(evidenceTemp); } catch { /* best-effort removal of unpublished temp */ }
    }
    if (manifestTemp) {
      try { unlinkSync(manifestTemp); } catch { /* best-effort removal of unpublished temp */ }
    }
    if (evidenceCreated && !sourceRemoved) {
      try { unlinkSync(evidenceName); } catch { /* preserve the original error */ }
    }
    throw err;
  } finally {
    if (entered) process.chdir(previousCwd);
  }
}

/**
 * The only S7-b repair: preserve a confirmed-corrupt health file in the
 * never-auto-delete quarantine. Callers must separately enforce the CLI's
 * `--fix --yes` and offline-daemon preconditions.
 */
export async function quarantineCorruptOperationalHealth(
  storeDir: string,
  options: { clock?: () => Date } = {},
): Promise<OperationalHealthFixResult> {
  const owner = await acquireDaemonOwner(storeDir, 'doctor', options.clock);
  try {
    const sourcePath = path.join(storeDir, OPERATIONAL_HEALTH_FILENAME);
    let source: Awaited<ReturnType<typeof fs.open>>;
    try {
      source = await fs.open(
        sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-needed', reason: 'missing' };
      throw new Error('operational health state could not be opened safely; refusing quarantine', { cause: err });
    }
    try {
      const inspection = await inspectOperationalHealthHandle(source);
      if (inspection.status === 'valid') return { status: 'not-needed', reason: 'valid' };
      if (inspection.status === 'unavailable') {
        throw new Error(`${inspection.reason}; refusing to quarantine unconfirmed corruption`);
      }

      const sourceStat = await source.stat({ bigint: true });
      if (!sourceStat.isFile()) throw new Error('operational health state is not a regular file; refusing quarantine');

      const quarantineDir = path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME);
      try {
        const existing = await fs.lstat(quarantineDir);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error('quarantine path is not a real directory; refusing quarantine');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await fs.mkdir(quarantineDir, { mode: 0o700 });
      }
      await ensureSecureDir(quarantineDir);
      const securedQuarantine = await fs.lstat(quarantineDir, { bigint: true });
      if (!securedQuarantine.isDirectory() || securedQuarantine.isSymbolicLink()) {
        throw new Error('quarantine path changed during validation; refusing quarantine');
      }
      const stamp = (options.clock ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
      const evidenceName = `${stamp}-${randomUUID()}-${OPERATIONAL_HEALTH_FILENAME}`;
      const manifestName = `${evidenceName}.manifest.json`;
      const hashed = publishQuarantineEvidencePinned(
        quarantineDir,
        securedQuarantine,
        sourcePath,
        source.fd,
        sourceStat,
        evidenceName,
        manifestName,
        (options.clock ?? (() => new Date()))().toISOString(),
        inspection.reason,
      );
      return { status: 'quarantined', evidenceName, manifestName, sha256: hashed.sha256, sizeBytes: hashed.sizeBytes };
    } finally {
      await source.close();
    }
  } finally {
    await owner.release();
  }
}

export { OPERATIONAL_HEALTH_FILENAME };
