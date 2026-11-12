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
  it('accepts an SPDX expression only when it grants MIT, Apache-2.0, BSD or ISC', () => {
    expect(['MIT', '(MIT OR GPL-3.0-only)', 'Apache-2.0 AND (BSD-3-Clause OR LGPL-2.1)', '0BSD', 'ISC'].map(permissive)).toEqual([true, true, true, true, true]);
    expect(['MIT AND GPL-3.0-only', 'LGPL-2.1', 'Apache-2.0 WITH LLVM-exception', '(MIT', 'SEE LICENSE IN LICENSE', undefined, { type: 'MIT' }].map(permissive))
      .toEqual([false, false, false, false, false, false, false]);
  });

  it('inventories the owner of each bundled file and each copied package, and refuses what is not permissive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'byok-license-gate-'));
    roots.push(root);
    write(root, 'package.json', { name: 'app', version: '1.0.0', license: 'MIT' });
    write(root, 'src/main.ts', '');
    write(root, 'node_modules/lib/package.json', { name: 'lib', version: '2.0.0', license: 'ISC' });
    // A bare type marker inside a package belongs to that package.
    write(root, 'node_modules/lib/esm/package.json', { type: 'module' });
    write(root, 'node_modules/lib/esm/index.js', '');
    write(root, 'stage/host/pi/package.json', { name: 'pi', version: '3.0.0', license: 'MIT' });
    write(root, 'stage/host/pi/node_modules/copyleft/package.json', { name: 'copyleft', version: '4.0.0', license: 'GPL-3.0-only' });
    const metafile = { inputs: { 'src/main.ts': {}, 'node_modules/lib/esm/index.js': {}, '(disabled):fs': {} } };

    const inventory = licenseInventory({ root, metafiles: [metafile], copiedRoots: [path.join(root, 'stage/host')] });
    expect(inventory.map(entry => `${entry.name}@${entry.version} ${entry.license} ${entry.where.split(path.sep).join('/')}`)).toEqual([
      'app@1.0.0 MIT .', 'copyleft@4.0.0 GPL-3.0-only stage/host/pi/node_modules/copyleft', 'lib@2.0.0 ISC node_modules/lib', 'pi@3.0.0 MIT stage/host/pi',
    ]);
    expect(licenseReport(inventory).refused.map(entry => entry.name)).toEqual(['copyleft']);
  });
});
