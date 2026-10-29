import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('sealed host build and the installed pi-subagents dependency', () => {
  it('keeps pi-subagents out of the sealed host, statically and lazily', () => {
    const meta = JSON.parse(read('node_modules/.cache/byok-sealed/metafile.json'));
    expect(Object.keys(meta.inputs).some(file => file.includes('/pi-subagents/'))).toBe(false);
    const sealed = read('dist/bin/pi-runtime-host-sealed.js');
    expect(sealed).not.toContain('pi-subagents');
    expect(sealed).not.toContain('pi-subagent-gate');
  });
  it('loads pi-subagents in the ordinary host only from the installed package, never from a bundle', () => {
    const ordinary = read('dist/bin/pi-runtime-host.js');
    // Opaque specifiers: a product bundler cannot inline the package.
    expect(ordinary).not.toMatch(/(?:from|import\()\s*['"]pi-subagents/u);
    expect(ordinary).toMatch(/=\s*["']pi-subagents["']/u);
    expect(ordinary).toMatch(/=\s*["']pi-subagents\/required-child-extensions["']/u);
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.dependencies['pi-subagents']).toBe('0.83.1');
    expect(manifest.devDependencies?.['pi-subagents']).toBeUndefined();
    const require = createRequire(path.join(root, 'dist/bin/pi-runtime-host.js'));
    let dir = path.dirname(require.resolve('pi-subagents'));
    while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))).toMatchObject({ name: 'pi-subagents', version: '0.83.1' });
  });
  it('emits the subagent child gate as its own entry beside the ordinary host', () => {
    const gate = read('dist/bin/pi-subagent-gate.js');
    expect(gate).toContain('tool_authorization_unavailable');
    expect(gate).not.toMatch(/(?:from|import\()\s*['"]@earendil-works\//u);
  });
  it('exports the same Pi entries as the ordinary host', () => {
    const sealed = read('dist/bin/pi-runtime-host-sealed.js');
    for (const name of ['runPiRpcHost', 'runPiPreparedHost', 'runPiDurableHost']) {
      expect(sealed).toMatch(new RegExp(`export \\{[^}]*\\b${name}\\b`, 'u'));
    }
  });
  it('ships a private dist mapping, no new public subpath', () => {
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.imports['#byok-pi-runtime-host-sealed']).toEqual({types:'./dist/bin/pi-runtime-host-sealed.d.ts',default:'./dist/bin/pi-runtime-host-sealed.js'});
    expect(manifest.files).toContain('dist');
    expect(existsSync(path.join(root, 'dist/bin/pi-runtime-host-sealed.d.ts'))).toBe(true);
    expect(Object.keys(manifest.exports).some(key => key.includes('sealed'))).toBe(false);
    expect(existsSync(path.join(root,'dist/bin/metafile-esm.json'))).toBe(false);
    expect(existsSync(path.join(root,'dist/assets/provenance/pi-subagents'))).toBe(false);
  });
  it('keeps the shipped TypeBox consumer at exact 1.3.27 and no schema compiler in either flavor', () => {
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.dependencies.typebox).toBe('1.3.27');
    for (const entry of ['pi-runtime-host.js','pi-runtime-host-sealed.js']) {
      const require = createRequire(path.join(root, 'dist/bin',entry));
      const resolved = require.resolve('typebox');
      let dir = path.dirname(resolved);
      while (!existsSync(path.join(dir,'package.json'))) dir=path.dirname(dir);
      expect(JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).version).toBe('1.3.27');
      expect(read('dist/bin/'+entry)).not.toMatch(/["']typebox\/compile["']/u);
    }
  });
});
