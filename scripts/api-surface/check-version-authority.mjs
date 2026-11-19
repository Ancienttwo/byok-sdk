#!/usr/bin/env node
// Version-authority gate for the release train and OAR-qualified runtimes.
//
// `packages/core/package.json` is the release train version — the same
// authority `scripts/release/check-package-graph.mjs` already derives every
// manifest assertion from. Since 0.28.2 keys carries that version too.
// Manifest alignment stays owned by `check:release-graph`. This check proves
// that `README.md` and `docs/spec.md` advertise the release train version
// and that the Claude and Codex adapter pins follow the vendored OAR policy.
//
// A README train mention is `@byok-sdk/<name>@x.y.z` for any published
// (non-private) workspace package, keys included, so the set of names is
// read from the manifests too. Names outside the workspace — the external
// `@byok-sdk/pi-*` fork artifacts — are not train mentions. Since 0.21.0 the
// unscoped `byok-sdk` umbrella is retired (ADR-035), so any `byok-sdk@x.y.z`
// mention is an error rather than a train mention.
//
// Usage:
//   node scripts/api-surface/check-version-authority.mjs [--root <dir>]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..', '..');

const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
const SCOPED_MENTION = new RegExp(`@byok-sdk/([a-z0-9][a-z0-9-]*)@(${SEMVER})`, 'g');
// `byok-sdk@x.y.z`, but never the tail of `@byok-sdk/<name>@x.y.z`.
const RETIRED_UMBRELLA_MENTION = new RegExp(`(?<![\\w/-])byok-sdk@(${SEMVER})`, 'g');
const SPEC_RELEASE = /current\s+aligned\s+release\s+is\s+`([^`]+)`/;

export function parseArgs(argv) {
  const options = { root: defaultRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readFile(root, relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) throw new Error(`${relative}: file not found`);
  return readFileSync(file, 'utf8');
}

function readJson(root, relative) {
  const source = readFile(root, relative);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${relative}: invalid JSON`, { cause: error });
  }
}

function readVersion(root, relative) {
  const manifest = readJson(root, relative);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${relative}: version must be a non-empty string`);
  }
  return manifest.version;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// Published train package names: every non-private manifest under packages/.
function readTrainNames(root) {
  const packagesDir = path.join(root, 'packages');
  const names = new Set();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join('packages', entry.name, 'package.json');
    if (!existsSync(path.join(root, manifestPath))) continue;
    const manifest = readJson(root, manifestPath);
    if (manifest.private === true || typeof manifest.name !== 'string') continue;
    if (manifest.name.startsWith('@byok-sdk/')) names.add(manifest.name.slice('@byok-sdk/'.length));
  }
  return names;
}

function checkReadmeMentions(errors, relative, source, trainNames, releaseVersion) {
  let found = 0;
  SCOPED_MENTION.lastIndex = 0;
  let match;
  while ((match = SCOPED_MENTION.exec(source)) !== null) {
    const [, name, version] = match;
    if (!trainNames.has(name)) continue;
    found += 1;
    if (version !== releaseVersion) {
      errors.push(
        `${relative}:${lineOf(source, match.index)}: release train package @byok-sdk/${name} is advertised as ${version}, but the authority says ${releaseVersion}`,
      );
    }
  }
  RETIRED_UMBRELLA_MENTION.lastIndex = 0;
  while ((match = RETIRED_UMBRELLA_MENTION.exec(source)) !== null) {
    errors.push(
      `${relative}:${lineOf(source, match.index)}: advertises the retired byok-sdk umbrella (byok-sdk@${match[1]}); name the scoped @byok-sdk/* packages instead`,
    );
  }
  if (found === 0) {
    errors.push(`${relative}: no release train version string found; expected ${releaseVersion}`);
  }
}

function checkSpecPhrase(errors, relative, source, pattern, expected, label) {
  const match = pattern.exec(source);
  if (match === null) {
    errors.push(`${relative}: the phrase naming the ${label} (${expected}) is missing`);
    return;
  }
  if (match[1] !== expected) {
    errors.push(
      `${relative}:${lineOf(source, match.index)}: ${label} is stated as ${match[1]}, but the authority says ${expected}`,
    );
  }
}

async function checkOarVersions(errors, root) {
  const vendor = 'packages/client/vendor/oar';
  const snapshots = readdirSync(path.join(root, vendor), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{7,40}$/.test(entry.name));
  if (snapshots.length !== 1) throw new Error(`${vendor}: expected one pinned OAR snapshot, found ${snapshots.length}`);
  const relative = `${vendor}/${snapshots[0].name}/.github/runtime-versions.json`;
  const { runtimes } = readJson(root, relative);

  for (const [runtime, constant] of [['claude', 'QUALIFIED_CLAUDE_VERSION'], ['codex', 'QUALIFIED_CODEX_VERSION']]) {
    const key = `${runtime}-aimock`;
    const entry = runtimes?.[key];
    if (typeof entry?.policy !== 'string') throw new Error(`${relative}: missing policy for ${key}`);
    if (entry.policy !== 'accepted') continue;
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new Error(`${relative}: ${key} version must be a non-empty string`);
    }
    const adapter = `packages/client/src/adapters/${runtime}/${runtime}-version.ts`;
    const qualified = (await import(pathToFileURL(path.join(root, adapter)).href))[constant];
    if (qualified !== entry.version) {
      errors.push(`${adapter}: ${runtime} SDK qualified version ${qualified} differs from OAR accepted version ${entry.version} (${relative})`);
    }
  }
}

export async function run(argv, out = console) {
  const { root } = parseArgs(argv);
  const releaseVersion = readVersion(root, 'packages/core/package.json');
  const errors = [];

  const readme = readFile(root, 'README.md');
  checkReadmeMentions(errors, 'README.md', readme, readTrainNames(root), releaseVersion);

  const spec = readFile(root, 'docs/spec.md');
  checkSpecPhrase(errors, 'docs/spec.md', spec, SPEC_RELEASE, releaseVersion, 'current aligned release');
  await checkOarVersions(errors, root);

  if (errors.length > 0) {
    for (const error of errors) out.error(error);
    out.error(`\nversion-authority: ${errors.length} mismatch(es)`);
    return 1;
  }
  out.log(
    `version-authority: README.md and docs/spec.md agree with the release train ${releaseVersion} (packages/core/package.json)`,
  );
  out.log('version-authority: vendored OAR accepted version check passed for Claude and Codex');
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(`version-authority: ${error.message}`);
    process.exitCode = 1;
  }
}
