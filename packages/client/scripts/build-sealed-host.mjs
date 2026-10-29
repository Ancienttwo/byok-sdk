import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
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
// The sealed host never references pi-subagents, statically or lazily.
assert.ok(!inputs.some(p => p.includes('/pi-subagents/')));
assert.ok(!readFileSync(path.join(dist, 'bin/pi-runtime-host-sealed.js'), 'utf8').includes('pi-subagents'), 'sealed host must not import pi-subagents');
const cache = path.join(root, 'node_modules/.cache/byok-sealed');
mkdirSync(cache, {recursive: true});
renameSync(metaPath, path.join(cache, 'metafile.json'));
console.log(`sealed build preserved all ${before.size} existing dist digests; pi-subagents excluded`);
