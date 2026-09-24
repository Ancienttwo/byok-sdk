#!/usr/bin/env node
// Version-authority gate for the human-facing docs.
//
// `packages/core/package.json` is the dispatch train version and
// `packages/keys/package.json` is the independent keys version — the same two
// authorities `scripts/release/check-package-graph.mjs` already derives every
// manifest assertion from. Manifest alignment stays owned by
// `check:release-graph`; this check only proves that `README.md` and
// `docs/spec.md` advertise those exact versions and no other one.
//
// A README train mention is `@byok-sdk/<name>@x.y.z` for any published
// (non-private) workspace package other than keys, so the set of names is
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
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..', '..');

const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';
const SCOPED_MENTION = new RegExp(`@byok-sdk/([a-z0-9][a-z0-9-]*)@(${SEMVER})`, 'g');
// `byok-sdk@x.y.z`, but never the tail of `@byok-sdk/<name>@x.y.z`.
const RETIRED_UMBRELLA_MENTION = new RegExp(`(?<![\\w/-])byok-sdk@(${SEMVER})`, 'g');
const KEYS_NAME = 'keys';
const SPEC_DISPATCH = /current\s+aligned\s+dispatch\s+release\s+is\s+`([^`]+)`/;
const SPEC_KEYS = /current\s+independent\s+keys\s+candidate\s+is\s+`([^`]+)`/;

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

function readVersion(root, relative) {
  const manifest = JSON.parse(readFile(root, relative));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${relative}: version must be a non-empty string`);
  }
  return manifest.version;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

// Published train package names: every non-private manifest under packages/
// except keys, which versions independently.
function readTrainNames(root) {
  const packagesDir = path.join(root, 'packages');
  const names = new Set();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === KEYS_NAME) continue;
    const manifestPath = path.join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private === true || typeof manifest.name !== 'string') continue;
    if (manifest.name.startsWith('@byok-sdk/')) names.add(manifest.name.slice('@byok-sdk/'.length));
  }
  return names;
}

function checkReadmeMentions(errors, relative, source, trainNames, dispatchVersion, keysVersion) {
  const found = { dispatch: 0, keys: 0 };
  SCOPED_MENTION.lastIndex = 0;
  let match;
  while ((match = SCOPED_MENTION.exec(source)) !== null) {
    const [, name, version] = match;
    let label;
    let expected;
    if (name === KEYS_NAME) {
      label = 'keys';
      expected = keysVersion;
    } else if (trainNames.has(name)) {
      label = 'dispatch';
      expected = dispatchVersion;
    } else {
      continue;
    }
    found[label] += 1;
    if (version !== expected) {
      errors.push(
        `${relative}:${lineOf(source, match.index)}: ${label} release (@byok-sdk/${name}) is advertised as ${version}, but the authority says ${expected}`,
      );
    }
  }
  RETIRED_UMBRELLA_MENTION.lastIndex = 0;
  while ((match = RETIRED_UMBRELLA_MENTION.exec(source)) !== null) {
    errors.push(
      `${relative}:${lineOf(source, match.index)}: advertises the retired byok-sdk umbrella (byok-sdk@${match[1]}); name the scoped @byok-sdk/* packages instead`,
    );
  }
  if (found.dispatch === 0) {
    errors.push(`${relative}: no dispatch release version string found; expected ${dispatchVersion}`);
  }
  if (found.keys === 0) {
    errors.push(`${relative}: no keys release version string found; expected ${keysVersion}`);
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

export function run(argv, out = console) {
  const { root } = parseArgs(argv);
  const dispatchVersion = readVersion(root, 'packages/core/package.json');
  const keysVersion = readVersion(root, 'packages/keys/package.json');
  const errors = [];

  const readme = readFile(root, 'README.md');
  checkReadmeMentions(errors, 'README.md', readme, readTrainNames(root), dispatchVersion, keysVersion);

  const spec = readFile(root, 'docs/spec.md');
  checkSpecPhrase(errors, 'docs/spec.md', spec, SPEC_DISPATCH, dispatchVersion, 'current aligned dispatch release');
  checkSpecPhrase(errors, 'docs/spec.md', spec, SPEC_KEYS, keysVersion, 'current independent keys candidate');

  if (errors.length > 0) {
    for (const error of errors) out.error(error);
    out.error(
      `\nversion-authority: ${errors.length} mismatch(es). packages/core/package.json (${dispatchVersion}) and packages/keys/package.json (${keysVersion}) are the only version authorities; update the docs to match them.`,
    );
    return 1;
  }
  out.log(
    `version-authority: README.md and docs/spec.md agree with the dispatch train ${dispatchVersion} (packages/core/package.json) and @byok-sdk/keys@${keysVersion}`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`version-authority: ${error.message}`);
    process.exitCode = 1;
  }
}
