import { verifyOfficialPiPackage, OFFICIAL_PI_PROVENANCE } from '../../packages/client/src/adapters/pi/official-pi-installation.mjs';
// Single authority for the Pi runtime identity across the release gates.
//
// `packages/client/package.json` pins the official
// `@earendil-works/pi-coding-agent` to one exact version, and pins every
// pure-JavaScript package of its upstream lockstep closure to that same exact
// version as a direct dependency, so an isolated consumer install cannot float
// a sibling through a `^x.y.z` range. `pi-tui` ships prebuilt `.node` addons
// and may not be a direct dependency (release-graph purity gate); it reaches
// the install only through the coding agent, and the lockfile and installed
// integrity checks below still hold it to the exact version. The integrity of each
// `name@version` is recorded once, in `bun.lock`. Every release gate derives the
// expected identity here instead of hardcoding any half of it:
//
// - `parsePiRuntimeIdentity`: exact pins, from the client manifest;
// - `readLockedPiClosure`: exact version + `sha512` integrity per closure
//   package, from `bun.lock`, and no fork alias anywhere in it;
// - `assertInstalledPiRuntime`: an isolated npm install holds exactly that
//   closure, npm installed exactly those integrities, and the installed
//   coding-agent file set is byte-identical to the official tarball whose
//   `sha512` is the locked integrity.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The module specifier and node_modules path the SDK resolves Pi through. */
export const PI_DEPENDENCY_SPECIFIER = '@earendil-works/pi-coding-agent';

/**
 * The upstream lockstep closure: the coding agent and every `@earendil-works/*`
 * package it installs. Upstream publishes them together at one version; the
 * client pins each one exactly at the coding-agent version.
 */
export const PI_RUNTIME_CLOSURE = Object.freeze([
  PI_DEPENDENCY_SPECIFIER,
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/chord',
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-tui',
]);

/**
 * Closure packages that may not be direct client dependencies: they ship
 * native addons, which the release-graph purity gate forbids on direct edges.
 */
const PI_INDIRECT_CLOSURE = Object.freeze(['@earendil-works/pi-tui', '@earendil-works/chord', '@earendil-works/pi-telemetry']);

/** The retired fork's package scope; nothing from it may be locked or installed. */
const PI_FORK_PREFIX = '@byok-sdk/pi-';

const PI_EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/**
 * Parse the exact Pi runtime identity out of a `@byok-sdk/client` manifest.
 * Ranges, dist-tags and npm aliases are rejected: a release gate cannot verify
 * an installed runtime whose expected identity is not exact. Every closure
 * package except `PI_INDIRECT_CLOSURE` must be a required dependency pinned to
 * the coding-agent version; those must not be direct dependencies at all.
 *
 * @param {{ dependencies?: Record<string, string> }} clientManifest
 * @param {string} [label] manifest origin, used in error messages
 * @returns {{ specifier: string, spec: string, packageName: string, version: string, closure: readonly string[] }}
 */
export function parsePiRuntimeIdentity(clientManifest, label = 'packages/client/package.json') {
  const spec = clientManifest?.dependencies?.[PI_DEPENDENCY_SPECIFIER];
  if (typeof spec !== 'string') {
    throw new Error(`${label}: ${PI_DEPENDENCY_SPECIFIER} must be a required dependency`);
  }
  if (!PI_EXACT_VERSION.test(spec) || spec !== OFFICIAL_PI_PROVENANCE.packageVersion) {
    throw new Error(`${label}: ${PI_DEPENDENCY_SPECIFIER} must be pinned to one exact official x.y.z version, got ${spec}`);
  }
  for (const name of PI_RUNTIME_CLOSURE) {
    const pinned = clientManifest.dependencies[name];
    if (PI_INDIRECT_CLOSURE.includes(name)) {
      if (pinned !== undefined) throw new Error(`${label}: ${name} ships native addons and must reach the install only through ${PI_DEPENDENCY_SPECIFIER}, got a direct ${pinned}`);
      continue;
    }
    if (pinned !== spec) {
      throw new Error(`${label}: ${name} must be a required dependency pinned exactly to ${spec}, got ${String(pinned)}`);
    }
  }
  return { specifier: PI_DEPENDENCY_SPECIFIER, spec, packageName: PI_DEPENDENCY_SPECIFIER, version: spec, closure: PI_RUNTIME_CLOSURE };
}

/**
 * Parse bun.lock, which is JSONC-like: trailing commas are legal and must be
 * dropped before JSON.parse.
 *
 * @param {string} text
 */
export function parseBunLock(text) {
  let cleaned = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      cleaned += character;
      index += 1;
      while (index < text.length) {
        cleaned += text[index];
        if (text[index] === '\\') {
          index += 1;
          cleaned += text[index] ?? '';
        } else if (text[index] === '"') {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }
    cleaned += character;
  }
  return JSON.parse(cleaned);
}

/**
 * Read the locked integrity of every closure package out of `bun.lock`. Every
 * `@earendil-works/*` entry must resolve to one exact version with a `sha512`
 * integrity; every closure package must resolve to exactly the pinned version,
 * with one integrity; no entry may resolve to the retired fork.
 *
 * @param {string} lockText bun.lock contents
 * @param {{ version: string }} identity from `parsePiRuntimeIdentity`
 * @param {string} [label]
 * @returns {Map<string, string>} closure package name -> locked `sha512-…` integrity
 */
export function readLockedPiClosure(lockText, identity, label = 'bun.lock') {
  const lock = parseBunLock(lockText);
  const errors = [];
  const locked = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const resolution = entry[0];
    if (resolution.includes(PI_FORK_PREFIX) || key.includes(PI_FORK_PREFIX)) {
      errors.push(`${label}: ${key} resolves to the retired fork (${resolution})`);
      continue;
    }
    if (!resolution.startsWith('@earendil-works/')) continue;
    const at = resolution.lastIndexOf('@');
    const name = resolution.slice(0, at);
    const version = resolution.slice(at + 1);
    const integrity = entry[entry.length - 1];
    if (!PI_EXACT_VERSION.test(version)) errors.push(`${label}: ${key} resolves to ${resolution}, not one exact version`);
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      errors.push(`${label}: ${key} (${resolution}) carries no sha512 integrity`);
      continue;
    }
    if (!PI_RUNTIME_CLOSURE.includes(name)) continue;
    if (version !== identity.version) {
      errors.push(`${label}: ${key} resolves to ${resolution}, but the Pi closure is pinned to ${identity.version}`);
      continue;
    }
    const previous = locked.get(name);
    if (previous !== undefined && previous !== integrity) {
      errors.push(`${label}: ${name}@${version} is locked with two integrities`);
      continue;
    }
    locked.set(name, integrity);
  }
  for (const name of PI_RUNTIME_CLOSURE) {
    if (!locked.has(name)) errors.push(`${label}: ${name}@${identity.version} is not locked`);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return locked;
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Collect every installed package manifest under `installRoot/node_modules`,
 * including nested `node_modules` trees, as `{ root, manifest }` pairs. Package
 * roots only: `node_modules/<name>` and `node_modules/@scope/<name>`.
 *
 * @param {string} installRoot
 */
function collectInstalledPackages(installRoot) {
  const found = [];
  const seen = new Set();
  const queue = [path.join(installRoot, 'node_modules')];
  while (queue.length > 0) {
    const modulesDir = queue.pop();
    if (!existsSync(modulesDir)) continue;
    // Symlinked stores (pnpm/bun layouts) can point back up the tree; walk each
    // real directory exactly once.
    const realModulesDir = realpathSync(modulesDir);
    if (seen.has(realModulesDir)) continue;
    seen.add(realModulesDir);
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.bin') continue;
      const roots = entry.name.startsWith('@')
        ? readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true })
            .filter((scoped) => scoped.isDirectory() || scoped.isSymbolicLink())
            .map((scoped) => path.join(modulesDir, entry.name, scoped.name))
        : [path.join(modulesDir, entry.name)];
      for (const root of roots) {
        const manifest = readManifest(path.join(root, 'package.json'));
        if (manifest !== undefined) found.push({ root, manifest });
        queue.push(path.join(root, 'node_modules'));
      }
    }
  }
  return found;
}

/**
 * Walks an npm tarball without shelling out to `tar`: the release gates run on
 * Windows runners too, so this depends on node builtins only. ustar walk —
 * 512-byte header blocks, octal size, contents padded to the next block — with
 * the ustar `prefix` field and pax `path` records applied, so paths longer than
 * 100 bytes keep their full name. Yields every regular file as `name -> Buffer`.
 *
 * @param {string} tarballPath
 */
export function* iterateTarballFiles(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath));
  let paxPath;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const sizeField = field(124, 136).trim();
    const size = Number.parseInt(sizeField, 8);
    const baseName = field(0, 100);
    if (!Number.isFinite(size)) throw new Error(`${tarballPath}: unreadable tar size for ${baseName}`);
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = field(257, 263).startsWith('ustar') ? field(345, 500) : '';
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (typeFlag === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = match?.[1];
    } else if (typeFlag === '0' || typeFlag === '\0') {
      yield [paxPath ?? (prefix === '' ? baseName : `${prefix}/${baseName}`), body];
      paxPath = undefined;
    } else {
      paxPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every regular file under `root`, excluding its own `node_modules`, as relative path -> sha256. */
function readInstalledFiles(root) {
  const files = new Map();
  const queue = [''];
  while (queue.length > 0) {
    const relative = queue.pop();
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (child === 'node_modules') continue;
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) files.set(child, sha256(readFileSync(path.join(root, child))));
    }
  }
  return files;
}

/**
 * Download one official tarball with `npm pack`, require its `sha512` to be the
 * locked integrity, and return its file set as relative path -> sha256.
 */
function readOfficialTarball(name, version, integrity, label, npm) {
  const packDir = mkdtempSync(path.join(os.tmpdir(), 'byok-pi-official-tarball-'));
  try {
    const result = spawnSync(
      npm.command,
      [...npm.prefix, 'pack', `${name}@${version}`, '--pack-destination', packDir, '--json', '--ignore-scripts'],
      { cwd: packDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) throw new Error(`${label}: npm pack ${name}@${version} failed (${result.status})\n${result.stderr}`);
    const [{ filename }] = JSON.parse(result.stdout);
    const tarballPath = path.join(packDir, filename);
    const actual = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
    if (actual !== integrity) {
      throw new Error(`${label}: registry tarball ${name}@${version} has integrity ${actual}, bun.lock records ${integrity}`);
    }
    const files = new Map();
    for (const [entry, body] of iterateTarballFiles(tarballPath)) {
      if (!entry.startsWith('package/')) throw new Error(`${label}: official tarball ${name}@${version} entry ${entry} is outside package/`);
      files.set(entry.slice('package/'.length), sha256(body));
    }
    return files;
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function assertFileSet(label, subject, expected, actual) {
  const missing = [...expected.keys()].filter((file) => !actual.has(file));
  const extra = [...actual.keys()].filter((file) => !expected.has(file));
  const modified = [...expected].filter(([file, digest]) => actual.has(file) && actual.get(file) !== digest).map(([file]) => file);
  if (missing.length > 0 || extra.length > 0 || modified.length > 0) {
    throw new Error(
      `${label}: ${subject} differs from the official tarball:\n` +
        `  missing: ${missing.join(', ') || '(none)'}\n  extra: ${extra.join(', ') || '(none)'}\n  modified: ${modified.join(', ') || '(none)'}`,
    );
  }
}

/**
 * Prove an isolated npm install holds exactly the pinned official Pi closure:
 * one coding-agent runtime, every closure package at exactly the pinned version
 * and installed by npm with exactly the locked integrity, nothing from the
 * retired fork, and a coding-agent file set byte-identical to the official
 * tarball whose `sha512` is the locked integrity. Throws on the first
 * violation. Downloads one tarball (`npm pack`), so it needs the registry.
 *
 * @param {string} installRoot directory whose `node_modules` npm installed (holds `package-lock.json`)
 * @param {{ packageName: string, version: string }} identity from `parsePiRuntimeIdentity`
 * @param {Map<string, string>} locked from `readLockedPiClosure`
 * @param {string} label gate name, used in error messages
 * @param {{ command: string, prefix: string[] }} npm how to invoke npm
 * @returns {{ root: string, manifest: Record<string, unknown> }} the single installed Pi package
 */
export function assertInstalledPiRuntime(installRoot, identity, locked, label, npm) {
  const installed = collectInstalledPackages(installRoot);
  const forks = installed.filter((entry) => String(entry.manifest.name).startsWith(PI_FORK_PREFIX));
  if (forks.length !== 0) {
    throw new Error(
      `${label}: the retired Pi fork is installed at ${forks.map((entry) => path.relative(installRoot, entry.root)).join(', ')}`,
    );
  }
  for (const name of PI_RUNTIME_CLOSURE) {
    const copies = installed.filter((entry) => entry.manifest.name === name);
    for (const entry of copies) verifyOfficialPiPackage(entry.root, name);
    const drift = copies.filter((entry) => entry.manifest.version !== identity.version);
    if (copies.length === 0 || drift.length !== 0 || (name === identity.packageName && copies.length !== 1)) {
      throw new Error(
        `${label}: expected ${name === identity.packageName ? 'exactly one' : 'only'} installed ${name}@${identity.version}, found ` +
          `${copies.map((entry) => `${entry.manifest.version} at ${path.relative(installRoot, entry.root)}`).join(', ') || 'none'}`,
      );
    }
  }
  const [pi] = installed.filter((entry) => entry.manifest.name === identity.packageName);

  // npm verified each tarball against the registry integrity before
  // extraction and records that integrity in its lockfile, EXCEPT for copies
  // it placed from the coding agent's own `npm-shrinkwrap.json`, which lists
  // the closure with no `integrity` field. A copy with a recorded integrity
  // must carry exactly the locked one; a copy without one is proven instead by
  // its file set being byte-identical to the official tarball whose `sha512`
  // is the locked integrity.
  const npmLock = readManifest(path.join(installRoot, 'package-lock.json'));
  if (npmLock?.packages === undefined) throw new Error(`${label}: ${installRoot} has no npm package-lock.json`);
  const copies = new Map(PI_RUNTIME_CLOSURE.map((name) => [name, []]));
  for (const [key, entry] of Object.entries(npmLock.packages)) {
    if (!key.includes('node_modules/')) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (copies.has(name)) copies.get(name).push({ key, version: entry.version, integrity: entry.integrity });
  }
  const official = new Map();
  const officialFiles = (name) => {
    if (!official.has(name)) official.set(name, readOfficialTarball(name, identity.version, locked.get(name), label, npm));
    return official.get(name);
  };
  let fileProven = 0;
  for (const [name, entries] of copies) {
    if (entries.length === 0) throw new Error(`${label}: npm installed no ${name}`);
    for (const entry of entries) {
      if (entry.version !== identity.version) {
        throw new Error(`${label}: npm installed ${entry.key} at ${entry.version}, expected ${identity.version}`);
      }
      if (entry.integrity !== undefined) {
        if (entry.integrity !== locked.get(name)) {
          throw new Error(`${label}: npm installed ${entry.key} with integrity ${entry.integrity}, bun.lock records ${locked.get(name)}`);
        }
        continue;
      }
      assertFileSet(label, `${entry.key} (no npm integrity)`, officialFiles(name), readInstalledFiles(path.join(installRoot, entry.key)));
      fileProven += 1;
    }
  }
  // The runtime itself is always proven by content, whatever npm recorded.
  const tarballFiles = officialFiles(identity.packageName);
  assertFileSet(label, `installed ${identity.packageName}@${identity.version}`, tarballFiles, readInstalledFiles(pi.root));
  console.log(
    `[${label}] official Pi closure ${PI_RUNTIME_CLOSURE.map((name) => name.slice('@earendil-works/'.length)).join(', ')}` +
      `@${identity.version}: recorded npm integrities equal bun.lock; single ${identity.packageName} at ` +
      `${path.relative(installRoot, pi.root)} matches the official tarball (${tarballFiles.size} files); ` +
      `${fileProven} shrinkwrap-placed cop${fileProven === 1 ? 'y' : 'ies'} without npm integrity matched their official tarballs; fork manifests=0`,
  );
  return pi;
}
