// app-installer.ts against the built SDK, on the paths that end before the OS
// service manager is asked anything: the smoke covers the rest on each platform.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app-installer.ts');
let root: string;
let config: string;
let installRoot: string;

function app(...args: string[]): { status: number | null; output: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [installer, ...args, '--config', config, '--install-root', installRoot], { encoding: 'utf8' });
  const line = run.stdout.trim().split('\n').at(-1) ?? '';
  return { status: run.status, output: line.startsWith('{') ? JSON.parse(line) as Record<string, unknown> : { stderr: run.stderr } };
}

async function payload(id: string, files: Record<string, string>, listed = files): Promise<string> {
  const dir = path.join(root, `payload-${id}`);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  const digests = Object.fromEntries(Object.entries(listed).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]));
  await writeFile(path.join(dir, 'byok-payload.json'), JSON.stringify({ format: 'byok-service-payload', version: 1, id, files: digests }));
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'byok-app-installer-'));
  config = path.join(root, 'config.json');
  installRoot = path.join(root, 'app');
  await writeFile(config, JSON.stringify({ productName: 'Installer Test', productId: 'byok-app-installer-test', storeDir: path.join(root, 'store') }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('reports no installation before install', () => {
  expect(app('status')).toEqual({ status: 0, output: { current: null, receipt: null } });
});

it('answers an upgrade without an installation with the typed refusal and changes nothing', async () => {
  const result = app('upgrade', '--payload', await payload('2.0.0', { 'byok-agent.mjs': 'v2' }));
  expect(result).toEqual({ status: 3, output: { error: 'installation_absent', stores: null, receipt: null } });
  await expect(readdir(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a payload whose bytes do not match its manifest before installing anything', async () => {
  const tampered = await payload('1.0.0', { 'byok-agent.mjs': 'tampered' }, { 'byok-agent.mjs': 'signed bytes' });
  expect(app('install', '--payload', tampered)).toEqual({ status: 3, output: { error: 'payload_invalid', stores: null, receipt: null } });
  expect(app('status').output).toEqual({ current: null, receipt: null });
});

it('refuses a payload carrying a file its manifest does not list', async () => {
  const dir = await payload('1.0.0', { 'byok-agent.mjs': 'v1', 'extra.js': 'unlisted' }, { 'byok-agent.mjs': 'v1' });
  expect(app('install', '--payload', dir).output).toMatchObject({ error: 'payload_invalid' });
});
