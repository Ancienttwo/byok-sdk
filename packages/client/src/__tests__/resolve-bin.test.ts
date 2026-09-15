import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientManifest } from '../adapters/pi/client-manifest';
import { PI_PACKAGE_NAME, resolvePiBin, resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';

// The pinned Pi identity comes from exactly one place: the installed client
// manifest. Overriding that single read is enough to drive every fail-closed
// path without touching node_modules; when the override is unset the real
// manifest is used, so the positive cases stay end-to-end.
const state = vi.hoisted(() => ({ manifest: undefined as ClientManifest | undefined }));

vi.mock('../adapters/pi/client-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/pi/client-manifest')>();
  return {
    ...actual,
    readClientManifest: (): ClientManifest => state.manifest ?? actual.readClientManifest(),
  };
});

function pinSpec(spec: string): void {
  state.manifest = { dependencies: { [PI_PACKAGE_NAME]: spec } };
}

describe('resolvePiBin', () => {
  const ORIGINAL = process.env.BYOK_PI_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL;
    state.manifest = undefined;
  });

  it('resolves the bin from the exact required dependency', () => {
    const result = resolvePiBin();
    expect(result.source).toBe('package');
    expect(result.command).toMatch(/pi-coding-agent/);
    expect(result.command.endsWith('cli.js')).toBe(true);
  });

  it('BYOK_PI_BIN explicitly overrides package resolution for tests and packaged sidecars', () => {
    process.env.BYOK_PI_BIN = '/tmp/some-fake-pi.mjs';
    expect(resolvePiBin()).toEqual({ command: '/tmp/some-fake-pi.mjs', source: 'env' });
  });

  it.each([
    '0.85.1001',
    'npm:@byok-sdk/pi-coding-agent@^0.85.1001',
    'npm:@byok-sdk/pi-coding-agent@latest',
    '^0.85.1001',
  ])('rejects a Pi dependency spec that is not an exact alias: %s', (spec) => {
    pinSpec(spec);
    expect(() => resolvePiRuntimeIdentity()).toThrow(
      `@byok-sdk/client pins ${PI_PACKAGE_NAME} to ${spec}, which is not an exact npm:<name>@<x.y.z> alias; the Pi runtime identity must be exact`,
    );
  });

  it('fails closed when the installed Pi version differs from the pinned alias', () => {
    delete process.env.BYOK_PI_BIN;
    pinSpec('npm:@byok-sdk/pi-coding-agent@9.9.9');
    expect(() => resolvePiBin()).toThrow(
      /resolved to @byok-sdk\/pi-coding-agent@\S+, but @byok-sdk\/client pins @byok-sdk\/pi-coding-agent@9\.9\.9/,
    );
  });

  it('fails closed when the installed Pi name differs from the pinned alias, with no PATH fallback', () => {
    delete process.env.BYOK_PI_BIN;
    pinSpec('npm:@byok-sdk/not-the-fork@0.85.1001');
    expect(() => resolvePiBin()).toThrow(
      /but @byok-sdk\/client pins @byok-sdk\/not-the-fork@0\.85\.1001/,
    );
    // The throw itself is the assertion that no unversioned global `pi` is
    // silently substituted: there is no second authority to fall back to.
  });
});

describe('Pi alias spec authority', () => {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');

  function aliasSpecSource(file: string): string {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    const match = /const PI_ALIAS_SPEC\s*=\s*([\s\S]*?);\n/.exec(text);
    if (match?.[1] === undefined) throw new Error(`no PI_ALIAS_SPEC literal in ${file}`);
    return match[1].replace(/\s+/g, '');
  }

  it('is literally identical in the TS runtime and the mjs release gate', () => {
    const ts = aliasSpecSource('packages/client/src/adapters/pi/resolve-bin.ts');
    const mjs = aliasSpecSource('scripts/release/pi-runtime-identity.mjs');
    expect(mjs).toBe(ts);

    // Both sides therefore accept and reject the same sample specs.
    const pattern = new RegExp(ts.slice(1, ts.lastIndexOf('/')));
    expect(pattern.test('npm:@byok-sdk/pi-coding-agent@0.85.1001')).toBe(true);
    expect(pattern.test('npm:pi-coding-agent@1.0.0')).toBe(true);
    for (const rejected of [
      '0.85.1001',
      'npm:@byok-sdk/pi-coding-agent@^0.85.1001',
      'npm:@byok-sdk/pi-coding-agent@latest',
      'npm:@byok-sdk/pi-coding-agent@0.85',
      '@byok-sdk/pi-coding-agent@0.85.1001',
    ]) {
      expect(pattern.test(rejected)).toBe(false);
    }
  });
});
