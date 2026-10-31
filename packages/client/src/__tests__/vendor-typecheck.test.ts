import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const clientRoot = path.resolve(import.meta.dirname, '../..');
const vendorRoot = path.join(clientRoot, 'vendor');
const typescriptRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
const tsc = path.join(typescriptRoot, 'lib', 'tsc.js');

describe('vendor typecheck boundary', () => {
  it('covers every vendored TypeScript source in the vendor project', () => {
    const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.vendor.json', '--noEmit', '--listFilesOnly'], {
      cwd: clientRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    const listed = new Set(result.stdout.split('\n').filter(Boolean).map(file => path.resolve(file)));
    const sources = readdirSync(vendorRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.ts$/.test(entry.name))
      .map(entry => path.resolve(entry.parentPath, entry.name));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter(file => !listed.has(file)).map(file => path.relative(vendorRoot, file))).toEqual([]);
  });
});
