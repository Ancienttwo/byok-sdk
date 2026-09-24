import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import clientManifest from '../../package.json';
import { PI_PACKAGE_NAME, resolvePiBin, resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';

// The pinned Pi identity comes from exactly one place: the statically imported client
// manifest. Overriding that single read is enough to drive every fail-closed
// path without touching node_modules; when the override is unset the real
// manifest is used, so the positive cases stay end-to-end.
const state = vi.hoisted(() => ({ pin: undefined as string | undefined }));

vi.mock('../adapters/pi/client-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/pi/client-manifest')>();
  return {
    ...actual,
    readClientPiRuntimePin: () => state.pin ?? actual.readClientPiRuntimePin(),
  };
});

function pinSpec(spec: string): void {
  state.pin = spec;
}

describe('resolvePiBin', () => {
  const ORIGINAL = process.env.BYOK_PI_BIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL;
    state.pin = undefined;
  });

  it('projects the exact pin from the bundled manifest import', () => {
    const expected = clientManifest.dependencies[PI_PACKAGE_NAME];
    const identity = resolvePiRuntimeIdentity();
    expect(identity).toEqual({ name: PI_PACKAGE_NAME, version: expected });
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
    'npm:@byok-sdk/pi-coding-agent@0.86.1001',
    'npm:@earendil-works/pi-coding-agent@0.87.1',
    '^0.87.1',
    '0.87',
    'latest',
  ])('rejects a Pi dependency spec that is not one exact version: %s', (spec) => {
    pinSpec(spec);
    expect(() => resolvePiRuntimeIdentity()).toThrow(
      `@byok-sdk/client pins ${PI_PACKAGE_NAME} to ${spec}, which is not one exact x.y.z version; the Pi runtime identity must be exact`,
    );
  });

  it('fails closed when the installed Pi version differs from the pin, with no PATH fallback', () => {
    delete process.env.BYOK_PI_BIN;
    pinSpec('9.9.9');
    expect(() => resolvePiBin()).toThrow(
      /resolved to @earendil-works\/pi-coding-agent@\S+, but @byok-sdk\/client pins @earendil-works\/pi-coding-agent@9\.9\.9/,
    );
    // The throw itself is the assertion that no unversioned global `pi` is
    // silently substituted: there is no second authority to fall back to.
  });
});

describe('Pi exact version authority', () => {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');

  function exactVersionSource(file: string): string {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    const match = /const PI_EXACT_VERSION\s*=\s*([\s\S]*?);\n/.exec(text);
    if (match?.[1] === undefined) throw new Error(`no PI_EXACT_VERSION literal in ${file}`);
    return match[1].replace(/\s+/g, '');
  }

  it('the real build gate rejects drift in the dedicated pin projection before module loading', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'byok-pin-projection-'));
    try {
      mkdirSync(path.join(root, 'scripts'));
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8'));
      manifest.byok.piRuntimePin = '9.9.9';
      writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
      const entry = path.join(root, 'scripts/check-adapters-entry.mjs');
      copyFileSync(path.join(repoRoot, 'packages/client/scripts/check-adapters-entry.mjs'), entry);
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('client byok.piRuntimePin must exactly project dependency alias');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is literally identical in the TS runtime and the mjs release gate', () => {
    const ts = exactVersionSource('packages/client/src/adapters/pi/resolve-bin.ts');
    const mjs = exactVersionSource('scripts/release/pi-runtime-identity.mjs');
    expect(mjs).toBe(ts);

    // Both sides therefore accept and reject the same sample specs.
    const pattern = new RegExp(ts.slice(1, ts.lastIndexOf('/')));
    expect(pattern.test('0.87.1')).toBe(true);
    expect(pattern.test('10.0.0')).toBe(true);
    for (const rejected of [
      'npm:@earendil-works/pi-coding-agent@0.87.1',
      'npm:@byok-sdk/pi-coding-agent@0.86.1001',
      '^0.87.1',
      '0.87',
      '00.87.1',
      '0.87.1-beta.0',
      'latest',
    ]) {
      expect(pattern.test(rejected)).toBe(false);
    }
  });
});
