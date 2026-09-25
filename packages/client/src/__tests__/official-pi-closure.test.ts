import { mkdtempSync, cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_PI_PACKAGES, OFFICIAL_PI_PROVENANCE, locateOfficialPiPackage,
  assertOfficialPiProvenance, assertOfficialPiManifest, verifyOfficialPiClosure, verifyOfficialPiPackage } from '../adapters/pi/official-pi-installation.mjs';

describe('official closure attestation guards', () => {
  it('checks every installed sibling and refuses a same-version byte substitution', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'byok-closure-'));
    const changed = '@earendil-works/pi-telemetry';
    try {
      const { roots } = verifyOfficialPiClosure(process.cwd());
      expect(new Set(roots.map(row => row.name))).toEqual(new Set(OFFICIAL_PI_PACKAGES));
      const installed = roots.find(row => row.name === changed);
      expect(installed).toBeDefined();
      const target = path.join(root, 'node_modules', changed);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(installed!.root, target, { recursive: true });
      expect(() => verifyOfficialPiPackage(target, changed)).not.toThrow();
      const file = path.join(root, 'node_modules', changed, 'package.json');
      writeFileSync(file, readFileSync(file, 'utf8') + ' ');
      expect(() => verifyOfficialPiPackage(target, changed)).toThrow('official Pi file digest mismatch');
      rmSync(path.join(root, 'node_modules', changed), { recursive: true });
      expect(() => verifyOfficialPiClosure(root)).toThrow('official Pi closure package unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['packageName', 'packageVersion', 'tarballIntegrity', 'upstreamCommit', 'provenanceDigest', 'closureDigest', 'compilerVersion'])('refuses changed %s', key => {
    expect(() => assertOfficialPiProvenance({ ...OFFICIAL_PI_PROVENANCE, [key]: 'changed' })).toThrow('official Pi provenance');
  });
  it('rejects a fork marker and a rewritten asset manifest even with a self-consistent Host digest', () => {
    expect(() => assertOfficialPiProvenance({ ...OFFICIAL_PI_PROVENANCE, forkBuild: 1001 })).toThrow();
    const bytes = readFileSync(path.join(locateOfficialPiPackage(OFFICIAL_PI_PROVENANCE.packageName, process.cwd()), 'package.json'));
    expect(() => assertOfficialPiManifest(bytes)).not.toThrow();
    expect(() => assertOfficialPiManifest(Buffer.concat([bytes, Buffer.from(' ')]))).toThrow('verified tarball');
  });
});
