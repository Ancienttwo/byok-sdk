import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('sealed factory build author and bounded compiler exclusion', () => {
  it('selects the refusal module and excludes the user-schema compiler module', () => {
    const meta = JSON.parse(read('node_modules/.cache/byok-sealed/metafile.json'));
    const inputs = Object.keys(meta.inputs);
    expect(inputs.some(file => file.endsWith('/src/runs/shared/structured-output-sealed.ts'))).toBe(true);
    expect(inputs.some(file => file.endsWith('/src/runs/shared/structured-output.ts'))).toBe(false);
    expect(inputs.some(file => file.includes('node_modules/pi-subagents/'))).toBe(false);
    // Fixed RPC schema Compile remains an explicit separate closure obligation.
    expect(inputs.some(file => file.endsWith('/src/extension/rpc.ts'))).toBe(true);
    const sealed = read('dist/bin/pi-runtime-host-sealed.js');
    expect(sealed).toContain('sealed_structured_output_unsupported');
    expect(sealed).not.toContain('Cannot load typebox/compile for structured output validation');
    expect(read('dist/bin/pi-runtime-host.js')).toContain('Cannot load typebox/compile for structured output validation');
  });
  it('ships a private dist mapping, no new public subpath or npm source runtime author', () => {
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.imports['#byok-pi-runtime-host-sealed']).toEqual({types:'./dist/bin/pi-runtime-host-sealed.d.ts',default:'./dist/bin/pi-runtime-host-sealed.js'});
    expect(manifest.files).toContain('dist');
    expect(existsSync(path.join(root, 'dist/bin/pi-runtime-host-sealed.d.ts'))).toBe(true);
    expect(Object.keys(manifest.exports).some(key => key.includes('sealed'))).toBe(false);
    expect(manifest.dependencies['pi-subagents']).toBeUndefined();
    expect(manifest.devDependencies['pi-subagents']).toBe('0.60.0');
    expect(existsSync(path.join(root,'dist/bin/metafile-esm.json'))).toBe(false);
    for (const file of ['LICENSE','PROVENANCE.md','source-manifest.json']) {
      expect(read('dist/assets/provenance/pi-subagents/0.60.0/'+file)).toBe(read('vendor/pi-subagents/0.60.0/'+file));
    }
  });
  it('keeps the shipped TypeBox consumer at exact 1.3.7 for both flavors', () => {
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.dependencies.typebox).toBe('1.3.7');
    for (const entry of ['pi-runtime-host.js','pi-runtime-host-sealed.js']) {
      const require = createRequire(path.join(root, 'dist/bin',entry));
      const resolved = require.resolve('typebox');
      let dir = path.dirname(resolved);
      while (!existsSync(path.join(dir,'package.json'))) dir=path.dirname(dir);
      expect(JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).version).toBe('1.3.7');
      expect(read('dist/bin/'+entry)).toMatch(/from ['"]typebox\/compile['"]/);
    }
  });
  it('binds every vendored byte to its explicit provenance delta', () => {
    const vendor = path.join(root,'vendor/pi-subagents/0.60.0');
    const manifest=JSON.parse(readFileSync(path.join(vendor,'source-manifest.json'),'utf8'));
    expect(manifest.files).toHaveLength(229);
    for(const row of manifest.files) {
      expect(sha(path.join(vendor,row.path)),row.path).toBe(row.vendoredSha256);
      expect(row.delta.length>0,row.path).toBe(row.upstreamSha256!==row.vendoredSha256);
    }
    for(const row of manifest.sdkFiles) expect(sha(path.join(vendor,row.path))).toBe(row.sha256);
  });
  it('has no compiler loader in the sealed backend source or executable sourcemap input', () => {
    const source=read('vendor/pi-subagents/0.60.0/src/runs/shared/structured-output-sealed.ts');
    expect(source).not.toMatch(/createRequire|import\(|typebox\/compile|new Function|eval\(/);
    const map=JSON.parse(read('dist/bin/pi-runtime-host-sealed.js.map'));
    expect(map.sources.some((file:string)=>file.endsWith('/structured-output.ts'))).toBe(false);
    expect(map.sources.some((file:string)=>file.endsWith('/structured-output-sealed.ts'))).toBe(true);
  });
});
