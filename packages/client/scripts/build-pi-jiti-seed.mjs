// Generates the jiti seed of the embedded pi-subagents extension graph (#1927):
// templates transformed once by the pinned jiti against a canonical root, and
// a manifest naming their sources, digests and relocation sites.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PI_JITI_SEED_CANONICAL_ROOT, PI_JITI_SEED_DIR, PI_JITI_SEED_FORMAT, PI_JITI_SEED_VERSION,
  canonicalSeedFile, fileUrlLiteral, piSubagentHostPeersSource, sha256,
} from '../src/adapters/pi/jiti-seed.mjs';

const client = fileURLToPath(new URL('../', import.meta.url));

/** The installed package `name` that Node resolution finds from `fromDir`. */
function installed(fromDir, name) {
  for (const base of createRequire(path.join(fromDir, 'package.json')).resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, 'package.json'))) return { dir: realpathSync(dir), manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) };
  }
  throw new Error(`build-pi-jiti-seed: ${name} is not installed beside ${fromDir}`);
}

const subagents = installed(client, 'pi-subagents');
const jitiPackage = installed(subagents.dir, 'jiti');
// Pi's embedded loader and the seed must agree on jiti's cache format.
assert.equal(installed(installed(client, '@earendil-works/pi-coding-agent').dir, 'jiti').manifest.version, jitiPackage.manifest.version);
const { createJiti } = createRequire(path.join(jitiPackage.dir, 'package.json'))('jiti');
const jiti = createJiti(path.join(client, 'package.json'), { fsCache: false, moduleCache: false });

/** The parent extension entry and every bundle chunk it imports, statically or lazily. */
function bundleGraph() {
  const seen = new Set(), pending = ['bundle/index.js'];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(subagents.dir, file), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)"(\.\.?\/[^"]+)"/gu)) {
      pending.push(path.posix.join(path.posix.dirname(file), match[1]));
    }
  }
  return [...seen].sort();
}

const { HOST_PEER_ALIASES } = await import(pathToFileURL(path.join(subagents.dir, 'src/runs/background/runner-aliases.js')).href);
const inputs = [
  ...bundleGraph().map(file => ({ base: 'pi-subagents', path: file, ts: false, source: readFileSync(path.join(subagents.dir, file), 'utf8') })),
  { base: 'host-peers', path: 'host-peers.ts', ts: true,
    source: piSubagentHostPeersSource(HOST_PEER_ALIASES.filter(alias => !alias.optional).map(alias => alias.specifier)) },
];

const templates = new Map();
const entries = inputs.map((input, index) => {
  const canonical = canonicalSeedFile(input.base, input.path);
  const code = jiti.transform({ filename: canonical, source: input.source, ts: input.ts, async: true, jsx: false });
  const literal = fileUrlLiteral(canonical);
  const sites = [];
  for (let at = code.indexOf(literal); at !== -1; at = code.indexOf(literal, at + literal.length)) sites.push(at);
  // Any other mention of the canonical root would be relocated by nothing.
  const marker = PI_JITI_SEED_CANONICAL_ROOT.slice(1);
  assert.equal(code.split(marker).length - 1, sites.length, `unrelocatable canonical path in ${input.base}/${input.path}`);
  const template = `templates/${String(index).padStart(3, '0')}.js`;
  templates.set(template, code);
  return { base: input.base, path: input.path, ts: input.ts, async: true, sourceSha256: sha256(input.source), template, templateSha256: sha256(code), sites };
});

const manifest = Buffer.from(JSON.stringify({
  format: PI_JITI_SEED_FORMAT, version: PI_JITI_SEED_VERSION,
  piSubagents: `${subagents.manifest.name}@${subagents.manifest.version}`, jiti: jitiPackage.manifest.version,
  canonicalRoot: PI_JITI_SEED_CANONICAL_ROOT, entries,
}, null, 1) + '\n');
const digest = sha256(manifest);
const seedDir = path.join(client, 'dist/assets', PI_JITI_SEED_DIR);
await rm(seedDir, { recursive: true, force: true });
await mkdir(path.join(seedDir, digest, 'templates'), { recursive: true });
await writeFile(path.join(seedDir, digest, 'manifest.json'), manifest);
for (const [file, code] of templates) await writeFile(path.join(seedDir, digest, file), code);
const bytes = [...templates.values()].reduce((sum, code) => sum + Buffer.byteLength(code), manifest.length);
console.log(`Pi jiti seed ${digest.slice(0, 12)}: ${entries.length} templates, ${bytes} bytes`);
