import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = new Map(readdirSync(dist, {recursive: true, withFileTypes: true}).filter(e => e.isFile())
  .map(e => {const file = path.join(e.parentPath, e.name); return [file, digest(file)];}));
assert.ok(before.size > 0, 'main build must precede sealed build');
const child = spawnSync('bun', ['run', 'tsup', '--config', 'tsup.sealed.config.ts'], {cwd: root, stdio: 'inherit'});
assert.equal(child.status, 0, 'sealed host build failed');
for (const [file, hash] of before) assert.equal(digest(file), hash, `sealed build overwrote ${file}`);
const metaPath = path.join(dist, 'bin/metafile-esm.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const inputs = Object.keys(meta.inputs).map(p => p.replaceAll('\\', '/'));
assert.ok(inputs.some(p => p.endsWith('/src/runs/shared/structured-output-sealed.ts')));
assert.ok(!inputs.some(p => p.endsWith('/src/runs/shared/structured-output.ts')));
assert.ok(!inputs.some(p => p.includes('node_modules/pi-subagents/')));
assert.ok(inputs.some(p => p.endsWith('/src/extension/rpc.ts')), 'fixed RPC schema residual must remain');
const cache = path.join(root, 'node_modules/.cache/byok-sealed');
mkdirSync(cache, {recursive: true});
renameSync(metaPath, path.join(cache, 'metafile.json'));
console.log(`sealed build preserved all ${before.size} existing dist digests; user-schema compiler subgraph excluded`);

const provenance = path.join(dist, 'assets/provenance/pi-subagents/0.60.0');
mkdirSync(provenance, {recursive: true});
for (const file of ['LICENSE', 'PROVENANCE.md', 'source-manifest.json']) {
  copyFileSync(path.join(root, 'vendor/pi-subagents/0.60.0', file), path.join(provenance, file));
}
