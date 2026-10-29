// Upgrade-manifest model: diff a released snapshot against the current tree,
// render the generated part of the manifest, and validate the authored part.
//
// The manifest (`packages/client/upgrade-manifest.json`, shipped in the
// client tarball) has two halves:
//
// - authored `entries`: each groups changed items under one impact
//   (additive | breaking), a Host-facing summary and a migration anchor;
// - generated `from`, `to` and `changes`: written by `--write` from the
//   baseline snapshot and the current tree, and compared byte for byte by the
//   gate, so the shipped file can never describe a different tree.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FIELDS_STATUS, snapshotDigest } from './snapshot.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_PATH = 'packages/client/upgrade-manifest.json';
export const BASELINE_PATH = 'scripts/release/upgrade-manifest/baseline.json';
export const IMPACTS = ['additive', 'breaking'];
export const ACCEPTANCE = ['accept', 'new-path-repair', 'reject'];
const ENTRY_KEYS = new Set(['id', 'impact', 'summary', 'migration', 'acceptance', 'items']);
const ISSUE_LINK = /^https:\/\/github\.com\/Ancienttwo\/byok-sdk\/(?:issues|pull)\/\d+$/;
// Categories whose before/after values mean something to a reader. Export
// digests and union markers do not, so `changes` omits them.
const SHOW_VALUES = new Set(['bin', 'store', 'example', 'config', 'interprocess']);

export const category = (item) => item.slice(0, item.indexOf(':'));

/** `{ item, change }` for every item that differs, sorted by item id. */
export function diffSnapshots(before, after) {
  const ids = [...new Set([...Object.keys(before.items), ...Object.keys(after.items)])].sort();
  const changes = [];
  for (const item of ids) {
    const from = before.items[item];
    const to = after.items[item];
    if (from === to) continue;
    const change = from === undefined ? 'added' : to === undefined ? 'removed' : 'changed';
    const row = { item, change };
    if (SHOW_VALUES.has(category(item))) {
      if (from !== undefined) row.before = from;
      if (to !== undefined) row.after = to;
    }
    changes.push(row);
  }
  return changes;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version ?? '');
  if (!match) throw new Error(`invalid version ${JSON.stringify(version)}`);
  return match.slice(1, 4).map(Number);
}

/** `none` | `patch` | `minor` | `major` from the released version to the tree version. */
export function bumpKind(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  for (let index = 0; index < 3; index += 1) {
    if (b[index] > a[index]) return ['major', 'minor', 'patch'][index];
    if (b[index] < a[index]) throw new Error(`version ${to} is older than the released baseline ${from}`);
  }
  return 'none';
}

/**
 * Q8 (docs/spec.md "Pre-1.0 package version policy"): a breaking entry ships
 * only in a MINOR before 1.0, and only in a MAJOR from 1.0. `none` means the
 * tree has not bumped yet; the gate then reports the bump it will need.
 */
export function breakingAllowed(from, to) {
  const bump = bumpKind(from, to);
  if (bump === 'none') return true;
  return parseVersion(to)[0] === 0 ? bump === 'minor' || bump === 'major' : bump === 'major';
}

/** GitHub-style heading slugs of a markdown file, plus explicit `<a id|name>` anchors. */
export function markdownAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = heading[1]
        .replace(/<[^>]+>/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
  }
  return anchors;
}

/** Generated fields of the manifest for a baseline and a current snapshot. */
export function generatedFields(baseline, current, entries) {
  const owner = new Map();
  for (const entry of entries ?? []) for (const item of entry.items ?? []) if (!owner.has(item)) owner.set(item, entry.id);
  return {
    from: { version: baseline.version, snapshotSha256: snapshotDigest(baseline) },
    to: { version: current.version, snapshotSha256: snapshotDigest(current) },
    configFields: CONFIG_FIELDS_STATUS,
    changes: diffSnapshots(baseline, current).map((row) => ({ ...row, entry: owner.get(row.item) ?? null })),
  };
}

/** The manifest object in its canonical key order. */
export function renderManifest(baseline, current, entries) {
  const generated = generatedFields(baseline, current, entries);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    package: '@byok-sdk/client',
    from: generated.from,
    to: generated.to,
    configFields: generated.configFields,
    entries,
    changes: generated.changes,
  };
}

export const serialize = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

/**
 * Every rule of the gate. Returns `{ errors, notes }`; the manifest passes
 * when `errors` is empty.
 */
export function checkManifest({ root, baseline, current, manifestText }) {
  const errors = [];
  const notes = [];
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { errors: [`${MANIFEST_PATH}: not JSON (${error.message})`], notes };
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!Array.isArray(manifest.entries)) errors.push(`${MANIFEST_PATH}: entries must be an array`);

  const changes = diffSnapshots(baseline, current);
  const changeOf = new Map(changes.map((row) => [row.item, row.change]));
  const owners = new Map();
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `entry ${typeof entry?.id === 'string' ? entry.id : `#${index}`}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`${label}: unknown field ${key}`);
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) errors.push(`${label}: id must be a lowercase slug`);
    else if (ids.has(entry.id)) errors.push(`${label}: duplicate id`);
    else ids.add(entry.id);
    if (!IMPACTS.includes(entry.impact)) errors.push(`${label}: impact must be one of ${IMPACTS.join(' | ')}`);
    if (typeof entry.summary !== 'string' || entry.summary.trim() === '') errors.push(`${label}: summary (the migration note) is required`);
    errors.push(...checkMigration(root, label, entry.migration));
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0) errors.push(`${label}: items must list at least one changed item`);
    for (const item of items) {
      if (owners.has(item)) errors.push(`${label}: ${item} is already covered by entry ${owners.get(item)}`);
      else owners.set(item, entry.id);
      const change = changeOf.get(item);
      if (change === undefined) {
        errors.push(`${label}: ${item} did not change since ${baseline.version}; remove it`);
        continue;
      }
      if (change === 'removed' && entry.impact !== 'breaking') errors.push(`${label}: ${item} is removed, so the entry must be breaking`);
    }
    const stores = items.filter((item) => category(item) === 'store' && changeOf.get(item) !== 'added');
    if (stores.length > 0) {
      if (!ACCEPTANCE.includes(entry.acceptance)) {
        errors.push(`${label}: a changed store needs acceptance (${ACCEPTANCE.join(' | ')}) for files the previous release wrote`);
      } else if (entry.acceptance !== 'accept' && entry.impact !== 'breaking') {
        errors.push(`${label}: acceptance ${entry.acceptance} makes the entry breaking`);
      }
    } else if (entry.acceptance !== undefined) {
      errors.push(`${label}: acceptance applies only to an entry with a changed store`);
    }
  }
  for (const row of changes) {
    if (!owners.has(row.item)) errors.push(`${row.item} ${row.change} since ${baseline.version} without a manifest entry`);
  }

  const breaking = entries.filter((entry) => entry?.impact === 'breaking').map((entry) => entry.id);
  try {
    const bump = bumpKind(baseline.version, current.version);
    if (breaking.length > 0 && !breakingAllowed(baseline.version, current.version)) {
      errors.push(`${current.version} is a ${bump.toUpperCase()} after ${baseline.version} but carries breaking entries (${breaking.join(', ')}); `
        + 'breaking changes ship only in a MINOR before 1.0 (Q8)');
    } else if (bump === 'none' && breaking.length > 0) {
      notes.push(`breaking entries (${breaking.join(', ')}): the next release after ${baseline.version} must be a MINOR`);
    }
  } catch (error) {
    errors.push(error.message);
  }

  const expected = serialize(renderManifest(baseline, current, entries));
  if (errors.length === 0 && manifestText !== expected) {
    errors.push(`${MANIFEST_PATH}: generated fields are stale; run node scripts/release/check-upgrade-manifest.mjs --write`);
  }
  return { errors, notes };
}

function checkMigration(root, label, migration) {
  if (typeof migration !== 'string' || migration === '') return [`${label}: migration anchor is required`];
  if (ISSUE_LINK.test(migration)) return [];
  const hash = migration.indexOf('#');
  if (hash <= 0) return [`${label}: migration must be <repo doc>.md#<anchor> or a byok-sdk issue/PR URL`];
  const file = migration.slice(0, hash);
  const anchor = migration.slice(hash + 1);
  if (!file.endsWith('.md') || path.isAbsolute(file) || file.split('/').includes('..')) return [`${label}: migration file must be a repo-relative .md`];
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) return [`${label}: migration file ${file} does not exist`];
  if (!markdownAnchors(readFileSync(absolute, 'utf8')).has(anchor)) return [`${label}: ${file} has no heading for #${anchor}`];
  return [];
}
