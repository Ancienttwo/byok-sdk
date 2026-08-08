import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DaemonConfig } from '../index';
import { auditLogPath } from '../bin/audit-log';
import { atomicWriteFile } from '../util/atomic-write';
import {
  collectDiagnostics,
  stableIdentifierHash,
  type CollectDiagnosticsOptions,
  type DiagnosticsSnapshot,
} from './diagnostics';

export const MAX_SUPPORT_AUDIT_TAIL_BYTES = 256 * 1024;
export const MAX_SUPPORT_AUDIT_FACTS = 200;

export interface SupportBundle {
  version: 1;
  generatedAt: string;
  product: { name: string; idHash: string };
  system: DiagnosticsSnapshot['system'];
  config: {
    serverProtocol: string;
    customStoreDir: boolean;
    hostedJournal: boolean;
    runtimeAllowlistCount?: number;
  };
  device: { status: DiagnosticsSnapshot['device']['status']; deviceIdHash?: string };
  runtimes: DiagnosticsSnapshot['runtimes'];
  control: DiagnosticsSnapshot['control'] extends infer T ? T : never;
  health: DiagnosticsSnapshot['health'];
  journal: DiagnosticsSnapshot['journal'];
  workspace: DiagnosticsSnapshot['workspace'];
  quarantine: {
    status: DiagnosticsSnapshot['quarantine']['status'];
    count: number;
    scannedCount: number;
    truncated: boolean;
    entries: Array<{ nameHash: string; sizeBytes: number; modifiedAt: string }>;
  };
  checks: DiagnosticsSnapshot['checks'];
  recentEvents: { included: number; sourceBytesRead: number; sourceTruncated: boolean; facts: Array<{ kind: string; ts: string }> };
  redaction: {
    policy: 'allowlist-v1';
    omitted: string[];
    transformed: string[];
  };
}

async function recentAuditFacts(storeDir: string): Promise<SupportBundle['recentEvents']> {
  const filePath = auditLogPath(storeDir);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
    }
    return { included: 0, sourceBytesRead: 0, sourceTruncated: false, facts: [] };
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
    const facts: Array<{ kind: string; ts: string }> = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.kind === 'string' && typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))) {
          facts.push({ kind: value.kind, ts: value.ts });
        }
      } catch {
        // A torn/malformed historical line is omitted and represented by the
        // included count; raw bytes are never copied into the bundle.
      }
    }
    return { included: facts.length, sourceBytesRead: bytesRead, sourceTruncated: stat.size > bytesRead, facts };
  } finally {
    await handle.close();
  }
}

function projectControl(control: DiagnosticsSnapshot['control']): DiagnosticsSnapshot['control'] {
  if (control.status === 'online') return control;
  return { status: 'offline', reason: 'daemon offline or unavailable' };
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
    product: { name: snapshot.product.name, idHash: stableIdentifierHash(snapshot.product.id) },
    system: snapshot.system,
    config: {
      serverProtocol: snapshot.config.serverProtocol,
      customStoreDir: snapshot.config.customStoreDir,
      hostedJournal: snapshot.config.hostedJournal,
      ...(snapshot.config.runtimeAllowlist ? { runtimeAllowlistCount: snapshot.config.runtimeAllowlist.length } : {}),
    },
    device: {
      status: snapshot.device.status,
      ...(snapshot.device.deviceId ? { deviceIdHash: stableIdentifierHash(snapshot.device.deviceId) } : {}),
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
      entries: snapshot.quarantine.entries.map((entry) => ({
        nameHash: stableIdentifierHash(entry.name),
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      })),
    },
    checks: snapshot.checks,
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
      transformed: ['productId/deviceId/quarantine filenames -> SHA-256', 'audit events -> kind/timestamp only'],
    },
  };
}

/**
 * Publish a complete bundle at a previously-unused path. The same-directory
 * hard-link makes publication atomic and `EEXIST`-safe: no reader can see a
 * partial JSON file and an existing operator artifact is never overwritten.
 */
export async function writeSupportBundle(outputPath: string, bundle: SupportBundle): Promise<void> {
  const dir = path.dirname(outputPath);
  const parentStat = await fs.stat(dir);
  if (!parentStat.isDirectory()) throw new Error('support bundle output parent is not a directory');
  const tempPath = path.join(dir, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await atomicWriteFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, fsync: true });
    await fs.link(tempPath, outputPath);
    await fs.chmod(outputPath, 0o600);
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
