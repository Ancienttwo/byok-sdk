import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonConfig, DeviceRecord } from '../index';
import type { ConnectControlResult } from '../bin/control-client';
import { runSupportBundleCommand } from '../bin/commands/support-bundle';
import { auditLogPath } from '../bin/audit-log';
import { DeviceStore } from '../daemon/store';
import {
  createSupportBundle,
  MAX_SUPPORT_AUDIT_FACTS,
  MAX_SUPPORT_AUDIT_TAIL_BYTES,
  writeSupportBundle,
} from '../diagnostics/support-bundle';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-support-bundle-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function unreachable(): Promise<ConnectControlResult> {
  return Promise.resolve({ ok: false, reason: 'SENTINEL_CONTROL_PATH_SECRET' });
}

function config(storeDir: string): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'SENTINEL_PRODUCT_ID',
    serverUrl: 'https://user:SENTINEL_URL_SECRET@example.invalid/private/path?token=SENTINEL_QUERY_SECRET',
    workspaceRoot: path.join(storeDir, 'SENTINEL_WORKSPACE_PATH'),
    storeDir,
    runtimeAllowlist: ['SENTINEL_ALLOWLIST_SECRET'],
  };
}

describe('support bundle privacy and bounds', () => {
  it('allowlists facts and excludes config, device, audit, control and path sentinels byte-for-byte', async () => {
    const dir = await tempDir();
    const record: DeviceRecord = {
      deviceId: 'SENTINEL_DEVICE_ID',
      accessToken: 'SENTINEL_ACCESS_TOKEN',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'SENTINEL_PRIVATE_KEY',
      devicePublicKey: 'SENTINEL_PUBLIC_KEY',
    };
    await new DeviceStore(dir).save(record);
    await fs.appendFile(
      auditLogPath(dir),
      `${JSON.stringify({ kind: 'progress', ts: '2026-08-09T00:00:00.000Z', raw: 'SENTINEL_PROMPT_TOOL_BODY' })}\n`,
    );
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.mkdir(quarantineDir);
    await fs.writeFile(path.join(quarantineDir, 'SENTINEL_QUARANTINE_FILENAME'), 'SENTINEL_QUARANTINE_BYTES');

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    const serialized = JSON.stringify(bundle);

    for (const sentinel of [
      'SENTINEL_PRODUCT_ID',
      'SENTINEL_URL_SECRET',
      'SENTINEL_QUERY_SECRET',
      'SENTINEL_WORKSPACE_PATH',
      'SENTINEL_DEVICE_ID',
      'SENTINEL_ACCESS_TOKEN',
      'SENTINEL_PRIVATE_KEY',
      'SENTINEL_PUBLIC_KEY',
      'SENTINEL_PROMPT_TOOL_BODY',
      'SENTINEL_CONTROL_PATH_SECRET',
      'SENTINEL_QUARANTINE_FILENAME',
      'SENTINEL_QUARANTINE_BYTES',
      'SENTINEL_ALLOWLIST_SECRET',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(bundle.recentEvents.facts).toEqual([{ kind: 'progress', ts: '2026-08-09T00:00:00.000Z' }]);
    expect(bundle.redaction.policy).toBe('allowlist-v1');
  });

  it('reads only a bounded audit tail and retains at most 200 facts', async () => {
    const dir = await tempDir();
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ kind: 'progress', ts: new Date(1_800_000_000_000 + index).toISOString(), padding: 'x'.repeat(200) }),
    );
    await fs.writeFile(auditLogPath(dir), `${lines.join('\n')}\n`);

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(bundle.recentEvents.facts).toHaveLength(MAX_SUPPORT_AUDIT_FACTS);
    expect(bundle.recentEvents.sourceBytesRead).toBeLessThanOrEqual(MAX_SUPPORT_AUDIT_TAIL_BYTES);
    expect(bundle.recentEvents.sourceTruncated).toBe(true);
  });

  it('atomically creates a 0600 artifact and refuses to overwrite it', async () => {
    const dir = await tempDir();
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    const outputPath = path.join(dir, 'support.json');

    await writeSupportBundle(outputPath, bundle);
    const first = await fs.readFile(outputPath, 'utf8');
    expect(JSON.parse(first)).toMatchObject({ version: 1, redaction: { policy: 'allowlist-v1' } });
    if (process.platform !== 'win32') expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    await expect(writeSupportBundle(outputPath, bundle)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(outputPath, 'utf8')).toBe(first);
  });

  it.skipIf(process.platform === 'win32')('does not chmod an operator-selected parent directory', async () => {
    const dir = await tempDir();
    const outputDir = path.join(dir, 'shared-output');
    await fs.mkdir(outputDir, { mode: 0o755 });
    await fs.chmod(outputDir, 0o755);
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    await writeSupportBundle(path.join(outputDir, 'support.json'), bundle);
    expect((await fs.stat(outputDir)).mode & 0o777).toBe(0o755);
  });

  it('CLI writes the requested bundle and prints an explicit redaction summary', async () => {
    const dir = await tempDir();
    const outputPath = path.join(dir, 'cli-support.json');
    const lines: string[] = [];
    await runSupportBundleCommand(config(dir), {
      outputPath,
      adapters: [],
      connectControl: unreachable,
      log: (line) => lines.push(line),
    });
    expect(JSON.parse(await fs.readFile(outputPath, 'utf8'))).toMatchObject({ version: 1 });
    expect(lines.some((line) => line.startsWith('redaction policy: allowlist-v1'))).toBe(true);
  });
});
