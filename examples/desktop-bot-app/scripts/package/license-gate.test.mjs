import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { licenseInventory, licenseReport, permissive } from './license-gate.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('license gate', () => {
  it('accepts an SPDX expression only when it grants a listed permissive license', () => {
    expect(['MIT', '(MIT OR GPL-3.0-only)', 'Apache-2.0 AND (BSD-3-Clause OR LGPL-2.1)', '0BSD', 'ISC', 'BlueOak-1.0.0', 'Unlicense'].map(permissive)).toEqual([true, true, true, true, true, true, true]);
    expect(['MIT AND GPL-3.0-only', 'LGPL-2.1', 'Apache-2.0 WITH LLVM-exception', '(MIT', 'MIT OR )', 'SEE LICENSE IN LICENSE', undefined, { type: 'MIT' }].map(permissive))
      .toEqual([false, false, false, false, false, false, false, false]);
  });

  it('inventories bundled owners, manifests and copied packages, refuses what is not permissive, and fails on an unreviewed copied file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'byok-license-gate-'));
    roots.push(root);
    write(root, 'package.json', { name: 'app', version: '1.0.0', license: 'MIT' });
    write(root, 'src/main.ts', '');
    write(root, 'node_modules/lib/package.json', { name: 'lib', version: '2.0.0', license: 'ISC' });
    // A bare type marker inside a package belongs to that package.
    write(root, 'node_modules/lib/esm/package.json', { type: 'module' });
    write(root, 'node_modules/lib/esm/index.js', '');
    write(root, 'node_modules/shell/package.json', { name: 'shell', version: '5.0.0', license: 'MIT' });
    write(root, 'stage/host/pi/package.json', { name: 'pi', version: '3.0.0', license: 'MIT' });
    write(root, 'stage/host/pi/image.wasm', '');
    write(root, 'stage/host/pi/node_modules/copyleft/package.json', { name: 'copyleft', version: '4.0.0', license: 'GPL-3.0-only' });
    write(root, 'stage/host/host', '');
    const options = { root, metafiles: [{ inputs: { 'src/main.ts': {}, 'node_modules/lib/esm/index.js': {}, '(disabled):fs': {} } }],
      manifests: [path.join(root, 'node_modules/shell/package.json')], copiedRoots: [path.join(root, 'stage/host')],
      unpackaged: { 'stage/host/host': 'the Host', 'stage/host/pi/image.wasm': 'another package' } };

    const inventory = licenseInventory(options);
    expect(inventory.packages.map(entry => `${entry.name}@${entry.version} ${entry.license} ${entry.where}`)).toEqual([
      'app@1.0.0 MIT .', 'copyleft@4.0.0 GPL-3.0-only stage/host/pi/node_modules/copyleft', 'lib@2.0.0 ISC node_modules/lib',
      'pi@3.0.0 MIT stage/host/pi', 'shell@5.0.0 MIT node_modules/shell',
    ]);
    expect(inventory.reviewed.map(entry => entry.file).sort()).toEqual(['stage/host/host', 'stage/host/pi/image.wasm']);
    expect(licenseReport(inventory).refused.map(entry => entry.name)).toEqual(['copyleft']);
    write(root, 'stage/host/native/addon.node', '');
    expect(() => licenseInventory(options)).toThrow('stage/host/native/addon.node ships in no package');
  });
});
