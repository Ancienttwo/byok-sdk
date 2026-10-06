import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

export function runtimeDependencyMetadata(manifest, label) {
  return Object.fromEntries(dependencyFields.map((field) => {
    if (Object.hasOwn(manifest, field) && (!isRecord(manifest[field]) ||
        Object.values(manifest[field]).some((range) => typeof range !== 'string' || range === ''))) {
      throw new Error(`${label}: ${field} must be an object of dependency ranges`);
    }
    return [field, manifest[field] ?? {}];
  }));
}

export function frozenRuntimeDependencyMetadata(artifact, label) {
  if (!isRecord(artifact.runtimeDependencies) || Object.keys(artifact.runtimeDependencies).length !== dependencyFields.length ||
      dependencyFields.some((field) => !Object.hasOwn(artifact.runtimeDependencies, field))) {
    throw new Error(`${label}: frozen artifact has no complete runtime dependency metadata; repack it`);
  }
  return runtimeDependencyMetadata(artifact.runtimeDependencies, `${label} frozen artifact`);
}

/** Explicit reviewed baseline, not an inference from a failed registry read. */
export function validateRegistryExpectations(plan, packageNames) {
  if (!isRecord(plan) || plan.schemaVersion !== 1 || !isRecord(plan.packages) ||
      Object.keys(plan).some((key) => !['schemaVersion', 'packages'].includes(key))) {
    throw new Error('registry expectations must declare schemaVersion 1 and a packages map');
  }
  if (Object.keys(plan.packages).length !== packageNames.length ||
      new Set(packageNames).size !== packageNames.length ||
      packageNames.some((name) => !Object.hasOwn(plan.packages, name))) {
    throw new Error('registry expectations package set mismatch');
  }
  for (const name of packageNames) {
    const entry = plan.packages[name];
    if (!isRecord(entry) || Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, 'priorPublication') || !Object.hasOwn(entry, 'previousLatest') ||
        !['none', 'existing'].includes(entry.priorPublication) ||
        !(entry.previousLatest === null || (typeof entry.previousLatest === 'string' && exactStableVersion.test(entry.previousLatest))) ||
        (entry.priorPublication === 'none' && entry.previousLatest !== null)) {
      throw new Error(`${name}: invalid explicit registry expectation`);
    }
  }
  return plan;
}

export function readRegistryExpectations(repoRoot, packageNames) {
  const plan = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/release/registry-expectations.json'), 'utf8'));
  return validateRegistryExpectations(plan, packageNames);
}

/** Frozen artifacts carry the reviewed baseline; older/unbound artifacts must be repacked. */
export function assertFrozenRegistryExpectations(manifest, expected, packageVersions) {
  const names = Object.keys(expected.packages);
  validateRegistryExpectations(manifest.registryExpectations, names);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== names.length ||
      new Set(manifest.packages.map((entry) => entry?.package)).size !== names.length ||
      manifest.packages.some((entry) => !names.includes(entry?.package))) {
    throw new Error('frozen release manifest package set mismatch');
  }
  for (const entry of manifest.packages) {
    if (entry.version !== packageVersions[entry.package]) throw new Error(`${entry.package}: frozen artifact version mismatch`);
    if (typeof entry.sha512Integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.sha512Integrity)) {
      throw new Error(`${entry.package}: frozen artifact has no exact SHA-512 integrity`);
    }
    frozenRuntimeDependencyMetadata(entry, entry.package);
  }
  for (const name of names) {
    for (const field of ['priorPublication', 'previousLatest']) {
      if (manifest.registryExpectations.packages[name][field] !== expected.packages[name][field]) {
        throw new Error(`${name}: frozen registry expectation ${field} differs from the reviewed plan`);
      }
    }
  }
}

function npmRead({ invocation, cwd, spawn = spawnSync }, args) {
  const result = spawn(invocation.command, [...invocation.prefix, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw new Error(`npm ${args[0]} could not complete: ${result.error?.message ?? result.signal ?? 'no exit status'}`);
  }
  return result;
}

/** E404 for an exact version can mean absent; package existence needs the stricter probe below. */
export function npmView(options) {
  const { selector, fields, allowNotFound = false } = options;
  const result = npmRead(options, ['view', selector, ...fields, '--json']);
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm view ${selector} returned unreadable output (${result.status})`);
  }
  if (result.status === 0) {
    if (isRecord(value) && Object.hasOwn(value, 'error')) throw new Error(`npm view ${selector} returned an error payload`);
    return { found: true, value };
  }
  if (allowNotFound && result.status > 0 && value?.error?.code === 'E404') return { found: false };
  throw new Error(`npm view ${selector} failed (${result.status}, ${value?.error?.code ?? 'unknown error'})`);
}

/** A missing npm default tag is not a missing package. Force latest, whose no-match is successful/empty. */
export function npmPackageExists(options) {
  const { name } = options;
  const result = npmRead(options, ['view', name, 'name', '--json', '--tag', 'latest']);
  if (result.status === 0 && result.stdout.trim() === '') return true;
  let value;
  try { value = JSON.parse(result.stdout); } catch {
    throw new Error(`npm package probe ${name} returned unreadable output (${result.status})`);
  }
  if (result.status === 0 && value === name) return true;
  // Reject npm's synthetic E404 for an unmatched version/tag or an unpublished
  // tombstone. Only a GET of this package's document can establish absence.
  const match = typeof value?.error?.summary === 'string'
    ? /^(?:404 )?Not Found - GET (https?:\/\/\S+)(?: -|$)/.exec(value.error.summary) : null;
  let packageDocument = false;
  if (match) {
    try {
      const url = new URL(match[1]);
      const pathname = decodeURIComponent(url.pathname);
      packageDocument = pathname.endsWith('/' + name) && !pathname.includes('/-/package/');
    } catch { /* Invalid URL/escaping cannot establish absence. */ }
  }
  if (result.status > 0 && value?.error?.code === 'E404' && packageDocument) return false;
  throw new Error(`npm package probe ${name} failed (${result.status}, ${value?.error?.code ?? 'unexpected response'})`);
}

/** npm dist-tag ls does not resolve a default version/tag; it emits text even with --json. */
export function npmDistTags(options) {
  const result = npmRead(options, ['dist-tag', 'ls', options.name, '--json']);
  if (result.status !== 0) throw new Error(`npm dist-tag ls ${options.name} failed (${result.status})`);
  const tags = {};
  for (const line of result.stdout.trim().split('\n')) {
    const match = /^([^\s:]+): ([^\s]+)$/.exec(line);
    if (!match || Object.hasOwn(tags, match[1])) throw new Error(`${options.name}: unreadable npm dist-tag list`);
    Object.defineProperty(tags, match[1], { value: match[2], enumerable: true });
  }
  assertDistTags(options.name, tags);
  return tags;
}

function assertDistTags(name, tags) {
  if (!isRecord(tags) || Object.values(tags).some((value) => typeof value !== 'string' || value === '')) {
    throw new Error(`${name}: registry dist-tags must be an object of version strings`);
  }
}

function assertLatest(name, tags, expectedLatest) {
  if (expectedLatest === null) {
    if (Object.hasOwn(tags, 'latest')) {
      throw new Error(`${name}: registry latest is ${JSON.stringify(tags.latest)}, expected latest to be absent`);
    }
  } else if (tags.latest !== expectedLatest) {
    throw new Error(`${name}: registry latest is ${JSON.stringify(tags.latest)}, expected stable ${expectedLatest}`);
  }
}

/** Run before any prerelease write; stable partial-publish resumability is unchanged. */
export function assertPrereleaseRegistryBaseline(entries, expectations, distTag, registry) {
  if (!distTag) return;
  validateRegistryExpectations(expectations, entries.map((entry) => entry.name));
  for (const { name } of entries) {
    const expected = expectations.packages[name];
    if (expected.priorPublication === 'none') {
      if (registry.packageExists(name)) throw new Error(`${name}: first-publication plan requires an absent package before publishing`);
    } else {
      const tags = registry.distTags(name);
      assertDistTags(name, tags);
      assertLatest(name, tags, expected.previousLatest);
    }
  }
}

/** Every package, including first publications, must pass the full post-publish readback. */
export function readRegistryMetadata({ packageVersions, frozenPackages, expectedVersion, expectations, distTag, view }) {
  validateRegistryExpectations(expectations, Object.keys(packageVersions));
  const metadata = [];
  for (const [packageName, packageVersion] of Object.entries(packageVersions)) {
    const result = view(packageName + '@' + packageVersion,
      ['name', 'version', 'maintainers', 'dist', 'dependencies', 'optionalDependencies', 'peerDependencies'], false);
    if (!result.found) throw new Error(`${packageName}: exact published version is missing from the registry`);
    const value = result.value;
    if (!isRecord(value) || value.name !== packageName || value.version !== packageVersion) {
      throw new Error(`${packageName}: registry identity/version mismatch`);
    }
    const frozen = frozenPackages.get(packageName);
    if (!frozen || frozen.version !== packageVersion || typeof frozen.sha512Integrity !== 'string' ||
        value.dist?.integrity !== frozen.sha512Integrity) {
      throw new Error(`${packageName}: registry tarball integrity differs from frozen artifact`);
    }
    const frozenDependencies = frozenRuntimeDependencyMetadata(frozen, packageName);
    const registryDependencies = runtimeDependencyMetadata(value, `${packageName} registry`);
    const tagsResult = view(packageName + '@' + packageVersion, ['dist-tags'], false);
    if (!tagsResult.found) throw new Error(`${packageName}: published package dist-tags are missing`);
    const distTags = tagsResult.value;
    assertDistTags(packageName, distTags);
    const selectedTag = distTag ?? 'latest';
    if (distTags[selectedTag] !== packageVersion) {
      throw new Error(`${packageName}: registry dist-tag ${selectedTag} is ${JSON.stringify(distTags[selectedTag])}, expected ${packageVersion}`);
    }
    if (distTag) assertLatest(packageName, distTags, expectations.packages[packageName].previousLatest);
    const maintainers = Array.isArray(value.maintainers) ? value.maintainers : [value.maintainers];
    if (!maintainers.some((entry) => typeof entry === 'string'
      ? /^ancienttwo(?: <[^<>\s]+>)?$/.test(entry) : entry?.name === 'ancienttwo')) {
      throw new Error(`${packageName}: ancienttwo is not present in registry maintainers`);
    }
    // Publishing can rewrite workspace edges; frozen tarball checks alone cannot
    // prove that the published graph still closes to the exact release train.
    for (const field of dependencyFields) {
      for (const [dependency, range] of Object.entries(registryDependencies[field])) {
        if (dependency.startsWith('@byok-sdk/') && range !== expectedVersion) {
          throw new Error(`${packageName}@${packageVersion}: registry ${field}.${dependency} is ${range}, expected ${expectedVersion} — the published graph is split`);
        }
      }
      if (Object.keys(registryDependencies[field]).length !== Object.keys(frozenDependencies[field]).length ||
          Object.entries(frozenDependencies[field]).some(([name, range]) => registryDependencies[field][name] !== range)) {
        throw new Error(`${packageName}: registry ${field} differs from frozen artifact metadata`);
      }
    }
    metadata.push(value);
  }
  return metadata;
}
