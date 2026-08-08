import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DaemonConfig, DaemonEvent } from '../index';
import { auditLogPath } from '../bin/audit-log';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureFile, type EnsureSecureDirOptions } from '../util/secure-dir';
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
  config: {
    serverProtocol: 'http' | 'https' | 'ws' | 'wss' | 'invalid' | 'unsupported';
    customStoreDir: boolean;
    hostedJournal: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: DiagnosticsSnapshot['device']['status']; deviceIdHash?: string };
  runtimes: DiagnosticsSnapshot['runtimes'];
  control:
    | { status: 'offline' }
    | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        transport: 'connecting' | 'open' | 'closed' | 'degraded' | 'revoked' | 'unavailable';
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
      };
  health: DiagnosticsSnapshot['health'];
  journal: DiagnosticsSnapshot['journal'];
  workspace: DiagnosticsSnapshot['workspace'];
  quarantine: {
    status: DiagnosticsSnapshot['quarantine']['status'];
    count: number;
    scannedCount: number;
    truncated: boolean;
    entries: DiagnosticsSnapshot['quarantine']['entries'];
  };
  checks: Array<Pick<DiagnosticsSnapshot['checks'][number], 'id' | 'status'>>;
  recentEvents: {
    status: 'available' | 'missing' | 'unavailable';
    included: number;
    sourceBytesRead: number;
    sourceTruncated: boolean;
    facts: Array<{ kind: DaemonEvent['kind']; ts: string }>;
  };
  redaction: {
    policy: 'allowlist-v1';
    omitted: string[];
    transformed: string[];
  };
}

const AUDIT_KINDS = new Set<DaemonEvent['kind']>([
  'artifact',
  'awaiting-approval',
  'cancelled',
  'claimed',
  'completed',
  'connection',
  'failed',
  'git-workspace',
  'offered',
  'paired',
  'progress',
  'runtimes-detected',
  'shutdown-complete',
  'shutdown-requested',
  'stale-approval-decision',
  'started',
  'unpaired',
]);

function isAuditKind(value: unknown): value is DaemonEvent['kind'] {
  return typeof value === 'string' && AUDIT_KINDS.has(value as DaemonEvent['kind']);
}

async function recentAuditFacts(storeDir: string): Promise<SupportBundle['recentEvents']> {
  const filePath = auditLogPath(storeDir);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    return { status: 'unavailable', included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
  }
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_SUPPORT_AUDIT_TAIL_BYTES);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const lines = text.split('\n').filter(Boolean).slice(-MAX_SUPPORT_AUDIT_FACTS);
    const facts: Array<{ kind: DaemonEvent['kind']; ts: string }> = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (isAuditKind(value.kind) && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))) {
          facts.push({ kind: value.kind, ts: new Date(Date.parse(value.ts)).toISOString() });
        }
      } catch {
        // A torn/malformed historical line is omitted and represented by the
        // included count; raw bytes are never copied into the bundle.
      }
    }
    return { status: 'available', included: facts.length, sourceBytesRead: bytesRead, sourceTruncated: stat.size > bytesRead, facts };
  } finally {
    await handle.close();
  }
}

function projectControl(control: DiagnosticsSnapshot['control']): SupportBundle['control'] {
  if (control.status === 'offline') return { status: 'offline' };
  const transport = ['connecting', 'open', 'closed', 'degraded', 'revoked'].includes(control.transport)
    ? (control.transport as 'connecting' | 'open' | 'closed' | 'degraded' | 'revoked')
    : 'unavailable';
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
    transport,
    activeTaskCount: control.activeTaskCount,
    pendingApprovalCount: control.pendingApprovalCount,
    operationalHealth,
    storagePresent: control.storage !== undefined,
  };
}

export async function createSupportBundle(
  config: DaemonConfig,
  storeDir: string,
  options: CollectDiagnosticsOptions = {},
): Promise<SupportBundle> {
  const [snapshot, recentEvents] = await Promise.all([collectDiagnostics(config, storeDir, options), recentAuditFacts(storeDir)]);
  return {
    version: 1,
    generatedAt: snapshot.generatedAt,
    product: snapshot.product,
    system: snapshot.system,
    config: {
      serverProtocol: snapshot.config.serverProtocol,
      customStoreDir: snapshot.config.customStoreDir,
      hostedJournal: snapshot.config.hostedJournal,
      ...(snapshot.config.runtimeAllowlistCount === undefined ? {} : { runtimeAllowlistCount: snapshot.config.runtimeAllowlistCount }),
    },
    device: {
      status: snapshot.device.status,
      ...(snapshot.device.deviceIdHash ? { deviceIdHash: snapshot.device.deviceIdHash } : {}),
    },
    runtimes: snapshot.runtimes,
    control: projectControl(snapshot.control),
    health: snapshot.health,
    journal: snapshot.journal,
    workspace: snapshot.workspace,
    quarantine: {
      status: snapshot.quarantine.status,
      count: snapshot.quarantine.count,
      scannedCount: snapshot.quarantine.scannedCount,
      truncated: snapshot.quarantine.truncated,
      entries: snapshot.quarantine.entries,
    },
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
export async function writeSupportBundle(
  outputPath: string,
  bundle: SupportBundle,
  secureFileOptions: EnsureSecureDirOptions = {},
): Promise<void> {
  const dir = path.dirname(outputPath);
  const parentStat = await fs.stat(dir);
  if (!parentStat.isDirectory()) throw new Error('support bundle output parent is not a directory');
  const tempPath = path.join(dir, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
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
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
