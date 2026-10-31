import { unmeasuredRetentionSnapshot, type RetentionSnapshot } from '../daemon/retention/sweeper';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { DaemonConfig } from '../daemon/create-daemon';
import type { DaemonHaltReason, DaemonLifecycle } from '../daemon/daemon-lifecycle';
import { auditLogPath } from '../bin/audit-log';
import { isDaemonRecordKind, type DaemonRecordKind } from '../daemon/daemon-record';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir, ensureSecureFile, type EnsureSecureDirOptions } from '../util/secure-dir';
import {
  collectDiagnostics,
  type CollectDiagnosticsOptions,
  type DiagnosticsSnapshot,
} from './diagnostics';

export const MAX_SUPPORT_AUDIT_TAIL_BYTES = 256 * 1024;
export const MAX_SUPPORT_AUDIT_FACTS = 200;

export interface SupportBundle {
  version: 1;
  generatedAt: string;
  product: { nameHash: string; idHash: string };
  system: DiagnosticsSnapshot['system'];
  storage: RetentionSnapshot;
  config: {
    serverProtocol: 'http' | 'https' | 'ws' | 'wss' | 'invalid' | 'unsupported';
    customStoreDir: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: DiagnosticsSnapshot['device']['status']; deviceIdHash?: string };
  runtimes: DiagnosticsSnapshot['runtimes'];
  runtimeSource: DiagnosticsSnapshot['runtimeSource'];
  control:
    | { status: 'offline' }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth:
          | { availability: 'unavailable' }
          | {
              availability: 'available';
              state: 'healthy' | 'degraded' | 'recovering';
              failureCount: number;
              windowMs: number;
              failureThreshold: number;
              crashCount: number;
              lastCrashAt?: string;
              currentRunStartedAt?: string;
            };
        storagePresent: boolean;
        outbound?: Pick<import('../daemon/outbound-settlement').OutboundStatus, 'accepted' | 'duplicate' | 'rejected' | 'rejectedByReason' | 'rejectedTerminals' | 'droppedEphemeral'>;
      };
  /** Issue #394: phase, connection and halt reason — closed enums only. */
  lifecycle:
    | { status: 'unknown' }
    | { status: 'known'; source: 'live' | 'audit'; phase: DaemonLifecycle['phase']; connection?: 'connecting' | 'open'; reason?: DaemonHaltReason };
  health: DiagnosticsSnapshot['health'];
  /** Issue #392: the last `start`'s `environment-resolved` record — closed values and a shell basename only. */
  environment: DiagnosticsSnapshot['environment'];
  /** #1095: each runtime environment's name and removal counts — never a name or value. */
  runtimeEnvironment: DiagnosticsSnapshot['runtimeEnvironment'];
  journal: DiagnosticsSnapshot['journal'];
  quarantine: {
    status: DiagnosticsSnapshot['quarantine']['status'];
    count: number;
    scannedCount: number;
    truncated: boolean;
    entries: DiagnosticsSnapshot['quarantine']['entries'];
  };
  /** #1097: log sizes only — never a path, a file name or log content. */
  logs: DiagnosticsSnapshot['logs'];
  checks: Array<Pick<DiagnosticsSnapshot['checks'][number], 'id' | 'status'>>;
  recentEvents: {
    status: 'available' | 'missing' | 'unavailable';
    included: number;
    sourceBytesRead: number;
    sourceTruncated: boolean;
    /** Kind and time of each recent record — kinds from `DAEMON_RECORD_KINDS` only. */
    facts: Array<{ kind: DaemonRecordKind; ts: string }>;
  };
  redaction: {
    policy: 'allowlist-v1';
    omitted: string[];
    transformed: string[];
  };
}

function sameFileState(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function recentAuditFacts(storeDir: string): Promise<SupportBundle['recentEvents']> {
  const filePath = auditLogPath(storeDir);
  let pathStat: import('node:fs').BigIntStats;
  try {
    pathStat = await fs.lstat(filePath, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const namedAfterOpen = await fs.lstat(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      !namedAfterOpen.isFile() ||
      namedAfterOpen.isSymbolicLink() ||
      !sameFileState(pathStat, stat) ||
      !sameFileState(stat, namedAfterOpen)
    ) {
      return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    const sourceSize = Number(stat.size);
    const length = Math.min(sourceSize, MAX_SUPPORT_AUDIT_TAIL_BYTES);
    const start = Math.max(0, sourceSize - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const afterRead = await handle.stat({ bigint: true });
    const namedAfterRead = await fs.lstat(filePath, { bigint: true });
    if (
      bytesRead !== length ||
      namedAfterRead.isSymbolicLink() ||
      !sameFileState(stat, afterRead) ||
      !sameFileState(afterRead, namedAfterRead)
    ) {
      return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const lines = text.split('\n').filter(Boolean).slice(-MAX_SUPPORT_AUDIT_FACTS);
    const facts: Array<{ kind: DaemonRecordKind; ts: string }> = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (isDaemonRecordKind(value.kind) && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))) {
          facts.push({ kind: value.kind, ts: new Date(Date.parse(value.ts)).toISOString() });
        }
      } catch {
        // A torn/malformed historical line is omitted and represented by the
        // included count; raw bytes are never copied into the bundle.
      }
    }
    return { status: 'available', included: facts.length, sourceBytesRead: bytesRead, sourceTruncated: sourceSize > bytesRead, facts };
  } catch {
    return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
  } finally {
    await handle.close();
  }
}

function projectControl(control: DiagnosticsSnapshot['control']): SupportBundle['control'] {
  if (control.status === 'offline') return { status: 'offline' };
  const operationalHealth =
    control.operationalHealth.availability === 'available'
      ? {
          availability: 'available' as const,
          state: control.operationalHealth.state,
          failureCount: control.operationalHealth.failureCount,
          windowMs: control.operationalHealth.windowMs,
          failureThreshold: control.operationalHealth.failureThreshold,
          crashCount: control.operationalHealth.crashCount,
        }
      : { availability: 'unavailable' as const };
  return {
    status: 'online',
    pid: control.pid,
    uptimeMs: control.uptimeMs,
    activeTaskCount: control.activeTaskCount,
    pendingApprovalCount: control.pendingApprovalCount,
    operationalHealth,
    storagePresent: true,
    ...(control.outbound === undefined ? {} : { outbound: { accepted: control.outbound.accepted, duplicate: control.outbound.duplicate, rejected: control.outbound.rejected, rejectedByReason: { ...control.outbound.rejectedByReason }, rejectedTerminals: control.outbound.rejectedTerminals, droppedEphemeral: control.outbound.droppedEphemeral } }),
  };
}

function projectLifecycle(lifecycle: DiagnosticsSnapshot['lifecycle']): SupportBundle['lifecycle'] {
  if (lifecycle.status === 'unknown') return { status: 'unknown' };
  const value = lifecycle.lifecycle;
  return {
    status: 'known',
    source: lifecycle.source,
    phase: value.phase,
    ...(value.phase === 'running' ? { connection: value.connection } : {}),
    ...(value.phase === 'halted' ? { reason: value.reason } : {}),
  };
}

export async function createSupportBundle(
  config: DaemonConfig,
  storeDir: string,
  options: CollectDiagnosticsOptions = {},
): Promise<SupportBundle> {
  const [snapshot, recentEvents] = await Promise.all([
    collectDiagnostics(config, storeDir, options),
    recentAuditFacts(storeDir),
  ]);
  return {
    version: 1,
    generatedAt: snapshot.generatedAt,
    storage: snapshot.control.status === 'online' ? snapshot.control.storage : unmeasuredRetentionSnapshot(),
    product: snapshot.product,
    system: snapshot.system,
    config: {
      serverProtocol: snapshot.config.serverProtocol,
      customStoreDir: snapshot.config.customStoreDir,
      ...(snapshot.config.runtimeAllowlistCount === undefined ? {} : { runtimeAllowlistCount: snapshot.config.runtimeAllowlistCount }),
    },
    device: {
      status: snapshot.device.status,
      ...(snapshot.device.deviceIdHash ? { deviceIdHash: snapshot.device.deviceIdHash } : {}),
    },
    runtimes: snapshot.runtimes,
    runtimeSource: snapshot.runtimeSource,
    control: projectControl(snapshot.control),
    lifecycle: projectLifecycle(snapshot.lifecycle),
    health: snapshot.health,
    environment: snapshot.environment,
    runtimeEnvironment: snapshot.runtimeEnvironment,
    journal: snapshot.journal,
    quarantine: {
      status: snapshot.quarantine.status,
      count: snapshot.quarantine.count,
      scannedCount: snapshot.quarantine.scannedCount,
      truncated: snapshot.quarantine.truncated,
      entries: snapshot.quarantine.entries,
    },
    logs: snapshot.logs,
    checks: snapshot.checks.map(({ id, status }) => ({ id, status })),
    recentEvents,
    redaction: {
      policy: 'allowlist-v1',
      omitted: [
        'server URL host/path/query',
        'store/workspace/config paths',
        'control token and provider credentials',
        'task, prompt, tool input/output and approval text',
        'raw audit and quarantine contents',
        'service log paths, file names and contents',
        'runtime environment variable names and values',
      ],
      transformed: ['productName/productId/deviceId/runtimeId/quarantine filenames -> SHA-256', 'audit events -> closed kind/timestamp only'],
    },
  };
}

/**
 * Publish a complete bundle at a previously-unused path. The same-directory
 * hard-link makes publication atomic and `EEXIST`-safe: no reader can see a
 * partial JSON file and an existing operator artifact is never overwritten.
 */
/**
 * #1097: a bundle written into the store would be swept, archived or shipped
 * with the store itself. The CLI and `exportDeviceSupportBundle` both refuse it.
 */
export async function isSupportBundleOutputInStore(storeDir: string, outputPath: string): Promise<boolean> {
  const [store, output] = await Promise.all([realPathOf(storeDir), realPathOf(outputPath)]);
  const relative = path.relative(store, output);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

/** The real path of the deepest existing ancestor (symlinks resolved) joined with the segments that do not exist yet. */
async function realPathOf(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT' || parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function writeSupportBundle(
  outputPath: string,
  bundle: SupportBundle,
  secureFileOptions: EnsureSecureDirOptions = {},
): Promise<void> {
  const dir = path.dirname(outputPath);
  const parentStat = await fs.stat(dir);
  if (!parentStat.isDirectory()) throw new Error('support bundle output parent is not a directory');
  // Harden an EMPTY private directory before any bundle byte exists. On
  // Windows, changing a file's DACL after writing is too late: another local
  // user can open the inherited-ACL temp file first and retain that handle.
  // Files created below this directory inherit the restrictive DACL, while
  // the final hard-link still remains on the operator-selected filesystem.
  const privateDir = path.join(dir, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.private`);
  const tempPath = path.join(privateDir, 'bundle.tmp');
  try {
    await fs.mkdir(privateDir, { mode: 0o700 });
    await ensureSecureDir(privateDir, secureFileOptions);
    await atomicWriteFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, fsync: true });
    await ensureSecureFile(tempPath, secureFileOptions);
    await fs.link(tempPath, outputPath);
    const published = await fs.open(outputPath, 'r+');
    try {
      await published.sync();
    } finally {
      await published.close();
    }
    if (process.platform !== 'win32') {
      const parent = await fs.open(dir, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await fs.rm(privateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
