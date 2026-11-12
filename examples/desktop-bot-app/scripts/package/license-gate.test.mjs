import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { licenseInventory, licenseReport, permissive } from './license-gate.mjs';
import { noticesText } from './notices.mjs';

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
    write(root, 'node_modules/img/package.json', { name: 'img', version: '6.0.0', license: 'Apache-2.0' });
    const options = { root, metafiles: [{ inputs: { 'src/main.ts': {}, 'node_modules/lib/esm/index.js': {}, '(disabled):fs': {} } }],
      manifests: [path.join(root, 'node_modules/shell/package.json')], copiedRoots: [path.join(root, 'stage/host')],
      unpackaged: { 'stage/host/host': { provenance: 'the Host' }, 'stage/host/pi/image.wasm': { provenance: 'from img', source: path.join(root, 'node_modules/img/package.json') } } };

    const inventory = licenseInventory(options);
    expect(inventory.packages.map(entry => `${entry.name}@${entry.version} ${entry.license} ${entry.where}`)).toEqual([
      'app@1.0.0 MIT .', 'copyleft@4.0.0 GPL-3.0-only stage/host/pi/node_modules/copyleft', 'img@6.0.0 Apache-2.0 node_modules/img',
      'lib@2.0.0 ISC node_modules/lib', 'pi@3.0.0 MIT stage/host/pi', 'shell@5.0.0 MIT node_modules/shell',
    ]);
    expect(inventory.reviewed.map(entry => `${entry.file} ${entry.package}`).sort()).toEqual(['stage/host/host undefined', 'stage/host/pi/image.wasm img@6.0.0']);
    expect(licenseReport(inventory).refused.map(entry => entry.name)).toEqual(['copyleft']);
    write(root, 'stage/host/native/addon.node', '');
    expect(() => licenseInventory(options)).toThrow('stage/host/native/addon.node ships in no package');
  });

  it('writes each package\'s license files and NOTICE, holds the MIT text for a package without one, lists first-party files, and fails for any other license without one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'byok-notices-'));
    roots.push(root);
    write(root, 'a/package.json', { name: 'a', version: '1.0.0', license: 'Apache-2.0' });
    write(root, 'a/LICENSE', 'Apache text');
    write(root, 'a/NOTICE', 'a notice');
    write(root, 'b/package.json', { name: 'b', version: '2.0.0', license: 'MIT', author: 'B Author' });
    write(root, 'c/package.json', { name: 'c', version: '3.0.0', license: 'BlueOak-1.0.0' });
    write(root, 'node/LICENSE', 'Node.js license and bundled licenses');
    const node = { version: 'v24.0.0', licenseFile: path.join(root, 'node/LICENSE') };
    const packages = [{ name: 'a', version: '1.0.0', license: 'Apache-2.0', where: 'a' }, { name: 'b', version: '2.0.0', license: 'MIT', where: 'b' }];

    const text = noticesText({ root, packages, node, firstParty: ['host'] });
    expect(text).toContain('\na@1.0.0\n');
    expect(text).toContain('--- LICENSE ---\nApache text');
    expect(text).toContain('--- NOTICE ---\na notice');
    expect(text).toContain('\nb@2.0.0\n');
    expect(text).toContain('Author (package.json): B Author');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('\nNode.js v24.0.0\n');
    expect(text).toContain('Node.js license and bundled licenses');
    expect(text).toMatch(/First-party files in resources\/host\/.*\n=+\nhost\n/);
    expect(() => noticesText({ root, node, firstParty: [], packages: [...packages, { name: 'c', version: '3.0.0', license: 'BlueOak-1.0.0', where: 'c' }] }))
      .toThrow('c@3.0.0 "BlueOak-1.0.0"');
  });
});
