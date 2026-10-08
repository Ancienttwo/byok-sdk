import { realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createPiInputPreparationCompiler, resolvePinnedPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { OFFICIAL_PI_PROVENANCE } from '../adapters/pi/official-pi-installation.mjs';
import { preparedCompileRequest } from './fixtures/prepared-compile-snapshot';

/**
 * pi-coding-agent and pi-ai depend on these four packages with a caret range,
 * so a fresh npm install takes the newest compatible release. The version is
 * synthetic: it only has to be newer than the official pin.
 */
const INDIRECT_PI_PACKAGES = ['pi-telemetry', 'pi-tui', 'pi-codemode', 'pi-mcp'];
const NEWER_INDIRECT_VERSION = '1.2.0';
const INDIRECT_MANIFEST = new RegExp(`[\\\\/]@earendil-works[\\\\/](?:${INDIRECT_PI_PACKAGES.join('|')})[\\\\/]package\\.json$`, 'u');

// Every module in this graph that reads an installed indirect manifest sees the
// newer version, as on a machine that installs today. The package bytes stay
// the pinned bytes; only the manifest version is newer.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((file: unknown, options?: unknown) => {
    const bytes = (actual.readFileSync as (file: unknown, options?: unknown) => string | Buffer)(file, options);
    if (typeof file !== 'string' || !INDIRECT_MANIFEST.test(file)) return bytes;
    const text = JSON.stringify({ ...JSON.parse(String(bytes)), version: NEWER_INDIRECT_VERSION });
    return typeof bytes === 'string' ? text : Buffer.from(text);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

/** The pi-telemetry manifest that the installed pi-ai resolves, found the way Node does. */
function installedTelemetryManifest(): string {
  let dir = path.dirname(realpathSync(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))));
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-telemetry', 'package.json');
    try {
      return realpathSync(candidate);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('the installed pi-ai resolves no pi-telemetry');
      dir = parent;
    }
  }
}

describe('prepared runtime identity with newer indirect Pi packages installed', () => {
  it('sees the newer indirect version in the installed tree', () => {
    const manifest = JSON.parse(readFileSync(installedTelemetryManifest(), 'utf8')) as { name: string; version: string };
    expect(manifest).toMatchObject({ name: '@earendil-works/pi-telemetry', version: NEWER_INDIRECT_VERSION });
  });

  it('resolves the pinned identity and compiles without reading the indirect versions', async () => {
    const identity = resolvePinnedPiRuntimeIdentity();
    expect(identity).toMatchObject({
      packageName: OFFICIAL_PI_PROVENANCE.packageName,
      packageVersion: OFFICIAL_PI_PROVENANCE.packageVersion,
      closureDigest: OFFICIAL_PI_PROVENANCE.closureDigest,
    });
    expect(identity.packageVersion).not.toBe(NEWER_INDIRECT_VERSION);
    const compiled = await createPiInputPreparationCompiler(identity).compile(preparedCompileRequest());
    expect(compiled.requestBody.length).toBeGreaterThan(0);
  });
});
