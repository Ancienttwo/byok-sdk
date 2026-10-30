import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runConfigCheckCommand } from '../bin/commands/config-check';

/**
 * #1095: `config check` prints the runtime environment policy every runtime
 * of the file takes. It runs no login shell, so it prints no names.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function check(runtimeEnvironment: unknown, json = false): Promise<{ code: number; out: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-config-check-env-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({
    productName: 'Acme', productId: 'acme', serverUrl: 'https://acme.example', storeDir: path.join(dir, 'store'),
    ...(runtimeEnvironment === undefined ? {} : { runtimeEnvironment }),
  }));
  const lines: string[] = [];
  const code = runConfigCheckCommand(file, { strict: false, json }, { log: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

it('prints the default and a pass policy as text', async () => {
  const defaults = await check(undefined);
  expect(defaults.code).toBe(0);
  expect(defaults.out).toContain('  runtime environment: base=login-shell pass=(none) (names: byok-agent doctor, from the running daemon)');
  const passed = await check({ pass: ['ACME_TOKEN_FILE', 'ACME_*'] });
  expect(passed.out).toContain('  runtime environment: base=login-shell pass=ACME_TOKEN_FILE,ACME_* (names: byok-agent doctor, from the running daemon)');
});

it('prints an allowlist policy, and the JSON report carries it with the base spelled out', async () => {
  const text = await check({ base: 'allowlist', allow: ['ACME_HOME'] });
  expect(text.out).toContain('  runtime environment: base=allowlist allow=ACME_HOME pass=(none) (names: byok-agent doctor, from the running daemon)');
  const json = JSON.parse((await check({ pass: ['ACME_TOKEN_FILE'] }, true)).out) as { runtimeEnvironment: unknown };
  expect(json.runtimeEnvironment).toEqual({ base: 'login-shell', pass: ['ACME_TOKEN_FILE'] });
});

it('prints no policy when the file would not construct a daemon', async () => {
  const invalid = await check({ pass: ['BYOK_SECRET'] });
  expect(invalid.code).toBe(1);
  expect(invalid.out).not.toContain('runtime environment:');
});
