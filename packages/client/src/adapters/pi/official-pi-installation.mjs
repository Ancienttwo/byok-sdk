import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import closure from './official-pi-closure.json' with { type: 'json' };

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = new Map(closure.packages.map(entry => [entry.name, entry]));
for (const entry of packages.values()) {
  if (digest(JSON.stringify(entry.provenanceBundle)) !== entry.provenanceDigest) throw new Error(`official Pi provenance bundle digest mismatch: ${entry.name}`);
}
const coding = packages.get('@earendil-works/pi-coding-agent');
export const OFFICIAL_PI_PROVENANCE = Object.freeze({
  packageName: coding.name, packageVersion: coding.version,
  tarballIntegrity: coding.tarballIntegrity, upstreamCommit: coding.upstreamCommit,
  provenanceDigest: coding.provenanceDigest, closureDigest: digest(JSON.stringify(closure)), compilerVersion: 4,
});
export const OFFICIAL_PI_PACKAGES = Object.freeze([...packages.keys()]);

/** Read package manifests as artifacts; never import a private package subpath. */
export function locateOfficialPiPackage(name, from) {
  let current = path.resolve(from);
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`official Pi closure package unavailable: ${name}`);
    current = parent;
  }
}

export function verifyOfficialPiPackage(root, name) {
  const expected = packages.get(name);
  if (!expected) throw new Error(`undeclared official Pi package: ${name}`);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== expected.version || manifest.byokFork !== undefined) {
    throw new Error(`official Pi package identity mismatch: ${name}`);
  }
  const observed = [];
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === 'node_modules') continue;
      if (entry.isDirectory()) pending.push(child);
      else observed.push(child);
    }
  }
  if (JSON.stringify(observed.sort()) !== JSON.stringify(expected.files.map(file => file.path).sort())) {
    throw new Error(`official Pi file inventory mismatch: ${name}`);
  }
  for (const file of expected.files) {
    const absolute = path.join(root, file.path);
    if (!lstatSync(absolute).isFile()) throw new Error(`official Pi file is not regular: ${name}/${file.path}`);
    const bytes = readFileSync(absolute);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`official Pi file digest mismatch: ${name}/${file.path}`);
  }
  return manifest;
}

/** Verify every resolved sibling instance, including npm shrinkwrap's nested copies. */
export function verifyOfficialPiClosure(from) {
  const queue = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core'].map(name => ({ name, root: locateOfficialPiPackage(name, from) }));
  const roots = new Map();
  while (queue.length) {
    const { name, root } = queue.shift();
    if (roots.has(root)) continue;
    const manifest = verifyOfficialPiPackage(root, name);
    roots.set(root, name);
    for (const [dependency, spec] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (dependency.startsWith('@byok-sdk/pi-') || String(spec).includes('@byok-sdk/pi-')) throw new Error('fork present in official Pi closure');
      if (dependency.startsWith('@earendil-works/')) {
        if (!packages.has(dependency)) throw new Error(`unattested Pi sibling: ${dependency}`);
        queue.push({ name: dependency, root: locateOfficialPiPackage(dependency, root) });
      }
    }
  }
  for (const name of OFFICIAL_PI_PACKAGES) {
    if (![...roots.values()].includes(name)) throw new Error(`official Pi closure missing sibling: ${name}`);
  }
  return { provenance: OFFICIAL_PI_PROVENANCE, roots: [...roots].map(([root, name]) => ({ root, name })) };
}

export function assertOfficialPiProvenance(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(OFFICIAL_PI_PROVENANCE).sort())
    || Object.entries(OFFICIAL_PI_PROVENANCE).some(([key, expected]) => value[key] !== expected)) {
    throw new Error('official Pi provenance differs from the verified release closure');
  }
}

export function assertOfficialPiManifest(bytes) {
  const expected = coding.files.find(file => file.path === "package.json");
  if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error("official Pi manifest differs from verified tarball");
}
