#!/usr/bin/env node
// Upgrade-manifest gate and generator (#1102).
//
// The released baseline snapshot (scripts/release/upgrade-manifest/baseline.json)
// is compared with a snapshot of this tree. Every changed Host-visible item
// (public export, entry, bin, union member, store format, vendored example)
// must belong to exactly one authored entry in packages/client/upgrade-manifest.json
// with an impact, a summary and a migration anchor; a breaking entry fails a
// PATCH bump (Q8). See docs/upgrade-manifest.md.
//
// Usage:
//   node scripts/release/check-upgrade-manifest.mjs [--root <dir>]
//       Check. Exit 1 on any error.
//   node scripts/release/check-upgrade-manifest.mjs --write [--root <dir>]
//       Rewrite the generated fields (from, to, configFields, changes) and keep
//       the authored entries. Still exits 1 while an item lacks an entry.
//   node scripts/release/check-upgrade-manifest.mjs --rebaseline <release checkout> [--root <dir>]
//       After a release is published: snapshot the release tag checkout into
//       the baseline and start an empty manifest from that version.
//   node scripts/release/check-upgrade-manifest.mjs --snapshot [--root <dir>]
//       Print the snapshot of the tree.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './upgrade-manifest/snapshot.mjs';
import { BASELINE_PATH, MANIFEST_PATH, bumpKind, checkManifest, renderManifest, serialize } from './upgrade-manifest/manifest.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const options = { root: defaultRoot, mode: 'check', release: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[(index += 1)] ?? '');
    else if (arg === '--write') options.mode = 'write';
    else if (arg === '--snapshot') options.mode = 'snapshot';
    else if (arg === '--rebaseline') {
      options.mode = 'rebaseline';
      options.release = path.resolve(argv[(index += 1)] ?? '');
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function run(argv, log = console) {
  const options = parseArgs(argv);
  const { root } = options;
  const current = buildSnapshot(root);
  if (options.mode === 'snapshot') {
    log.log(JSON.stringify(current, null, 2));
    return 0;
  }
  const baselineFile = path.join(root, BASELINE_PATH);
  const manifestFile = path.join(root, MANIFEST_PATH);

  if (options.mode === 'rebaseline') {
    const released = buildSnapshot(options.release);
    if (existsSync(baselineFile)) {
      const previous = readJson(baselineFile);
      if (bumpKind(previous.version, released.version) === 'none') {
        throw new Error(`release checkout is ${released.version}, not newer than the baseline ${previous.version}`);
      }
    }
    writeFileSync(baselineFile, `${JSON.stringify(released, null, 2)}\n`);
    writeFileSync(manifestFile, serialize(renderManifest(released, current, [])));
    log.log(`[upgrade-manifest] baseline is now ${released.version}; the manifest starts empty`);
  }

  const baseline = readJson(baselineFile);
  if (options.mode === 'write') {
    const entries = existsSync(manifestFile) ? readJson(manifestFile).entries ?? [] : [];
    writeFileSync(manifestFile, serialize(renderManifest(baseline, current, entries)));
  }
  const manifestText = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : '';
  const { errors, notes } = checkManifest({ root, baseline, current, manifestText });
  for (const note of notes) log.log(`[upgrade-manifest] note: ${note}`);
  if (errors.length > 0) {
    for (const error of errors) log.error(`[upgrade-manifest] ${error}`);
    log.error(`[upgrade-manifest] ${errors.length} error(s); see docs/upgrade-manifest.md`);
    return 1;
  }
  log.log(`[upgrade-manifest] ok: ${baseline.version} -> ${current.version}, ${Object.keys(current.items).length} items`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`[upgrade-manifest] ${error.message}`);
    process.exitCode = 1;
  }
}
