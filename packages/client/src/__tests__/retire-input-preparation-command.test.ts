import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../index';
import type { ConnectControlResult, ControlClient } from '../bin/control-client';
import { runRetireInputPreparationCommand } from '../bin/commands/retire-input-preparation';
import { InputPreparationRetirementDaemonRunningError } from '../daemon/input-preparation-retirement';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const clock = (): Date => new Date('2026-09-28T05:06:07.008Z');

function offline(): () => Promise<ConnectControlResult> {
  return async () => ({ ok: false, reason: 'daemon is not running (no control.token found)' });
}

function online(): { connectControl: () => Promise<ConnectControlResult>; close: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const request = vi.fn();
  const client: ControlClient = { request: request as never, subscribe: () => ({ close: vi.fn() }), close };
  return { connectControl: async () => ({ ok: true, client }), close, request };
}

async function seed(): Promise<{ root: string; storeDir: string; config: DaemonConfig }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-ip-retire-cmd-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const storeDir = path.join(root, 'store');
  const namespace = path.join(storeDir, 'input-preparation');
  await fs.mkdir(path.join(namespace, 'artifacts'), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ format: 'byok.input-preparation.record', version: 7, recordId: 'r1', state: 'prepared', artifactBytes: 3 });
  await fs.writeFile(path.join(namespace, 'records.jsonl'), `${line}\n`);
  await fs.writeFile(path.join(namespace, 'artifacts', 'r1.json'), '{"D":1}');
  const config: DaemonConfig = {
    localAgentRelease: { version: '0.0.0-test' },
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'http://example.invalid',
    workspaceRoot: path.join(root, 'ws'),
    storeDir,
  };
  return { root, storeDir, config };
}

async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await fs.readdir(current)).sort()) {
      const full = path.join(current, entry);
      const stat = await fs.lstat(full);
      if (stat.isDirectory()) {
        out[path.relative(dir, full)] = 'dir';
        await walk(full);
      } else out[path.relative(dir, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

describe('byok-agent retire-input-preparation', () => {
  it('without --yes is a dry run: reports counts and the store tree is byte-identical', async () => {
    const { storeDir, config } = await seed();
    const before = await treeHash(storeDir);
    const connectControl = vi.fn(offline());
    const lines: string[] = [];
    const result = await runRetireInputPreparationCommand(config, { log: (l) => lines.push(l), connectControl, clock });
    expect(result.status).toBe('inspected');
    expect(lines.join('\n')).toContain('versions=v7=1 pinned=0');
    expect(lines.join('\n')).toContain('artifacts: files=1');
    expect(lines.at(-1)).toContain('dry run: nothing was written');
    expect(connectControl).not.toHaveBeenCalled();
    expect(await treeHash(storeDir)).toEqual(before);
  });

  it('--yes refuses while the control socket is online and writes nothing', async () => {
    const { storeDir, config } = await seed();
    const before = await treeHash(storeDir);
    const control = online();
    await expect(
      runRetireInputPreparationCommand(config, { confirmed: true, connectControl: control.connectControl, clock, log: () => {} }),
    ).rejects.toBeInstanceOf(InputPreparationRetirementDaemonRunningError);
    expect(control.close).toHaveBeenCalled();
    expect(control.request).not.toHaveBeenCalled();
    expect(await treeHash(storeDir)).toEqual(before);
  });

  it('--yes retires, then a second --yes is a no-op', async () => {
    const { storeDir, config } = await seed();
    const lines: string[] = [];
    const first = await runRetireInputPreparationCommand(config, { confirmed: true, connectControl: offline(), clock, log: (l) => lines.push(l) });
    expect(first.status).toBe('retired');
    expect(lines.join('\n')).toContain(path.join(storeDir, 'input-preparation-retired', '2026-09-28T05-06-07-008Z-v7'));
    const after = await treeHash(storeDir);
    const second = await runRetireInputPreparationCommand(config, { confirmed: true, connectControl: offline(), clock, log: (l) => lines.push(l) });
    expect(second.status).toBe('nothing-to-retire');
    expect(lines.at(-1)).toContain('nothing to retire');
    expect(await treeHash(storeDir)).toEqual(after);
  });

  it('packaged CLI dispatches the subcommand: dry run by default, --yes retires', async () => {
    const { root, storeDir, config } = await seed();
    const configPath = path.join(root, 'agent.json');
    const { localAgentRelease: _release, ...cliConfig } = config;
    await fs.writeFile(configPath, JSON.stringify(cliConfig));
    const bin = path.resolve('dist/bin/byok-agent.js');
    const before = await treeHash(storeDir);

    const dry = spawnSync(process.execPath, [bin, 'retire-input-preparation', '--json', '--config', configPath], { encoding: 'utf8', timeout: 20_000 });
    expect(dry.stderr).toBe('');
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ status: 'inspected', inspection: { versionCounts: { 7: 1 }, artifactFileCount: 1 } });
    expect(await treeHash(storeDir)).toEqual(before);

    const run = spawnSync(process.execPath, [bin, 'retire-input-preparation', '--yes', '--json', '--config', configPath], { encoding: 'utf8', timeout: 20_000 });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'retired', manifest: { retiredRecordVersions: [7] } });
    await expect(fs.lstat(path.join(storeDir, 'input-preparation'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
