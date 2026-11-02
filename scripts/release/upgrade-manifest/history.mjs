// Upgrade-manifest history (#1316): every released manifest, kept byte for
// byte as `packages/client/upgrade-history/<from>-<to>.json`.
//
// The shipped manifest covers one release. A rebaseline archives the release
// checkout's manifest here before it starts the next one, so a Host that skips
// releases can read every increment since 0.31.0 (`upgrade check --from`).
// The archive is never recomputed: each file must equal the manifest of tag
// `v<to>`, and the files chain from 0.31.0 to the current manifest's `from`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MANIFEST_PATH, bumpKind } from './manifest.mjs';

export const HISTORY_DIR = 'packages/client/upgrade-history';
/** The first release that shipped a manifest. */
export const HISTORY_START = '0.31.0';
const ARCHIVE_NAME = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.json$/;

/**
 * Archives the manifest of a release checkout as `<from>-<to>.json`. The
 * released manifest must span a release (`from < to`, `to` equal to the
 * checkout's version); an existing archive must already hold the same bytes.
 */
export function archiveRelease(root, releaseRoot, releaseVersion) {
  const bytes = readFileSync(path.join(releaseRoot, MANIFEST_PATH));
  const manifest = JSON.parse(bytes.toString('utf8'));
  const from = manifest.from?.version;
  const to = manifest.to?.version;
  if (to !== releaseVersion || bumpKind(from, to) === 'none') {
    throw new Error(`release checkout ${MANIFEST_PATH} spans ${from} -> ${to}, not a release of ${releaseVersion}`);
  }
  const file = path.join(root, HISTORY_DIR, `${from}-${to}.json`);
  if (existsSync(file)) {
    if (!readFileSync(file).equals(bytes)) throw new Error(`${HISTORY_DIR}/${from}-${to}.json exists with different bytes`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function tagManifest(root, tag) {
  const result = spawnSync('git', ['show', `${tag}:${MANIFEST_PATH}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git show ${tag} could not start: ${result.error.message}`);
  return result.status === 0 ? result.stdout : null;
}

/** Errors of the archive under `root` against the current manifest's `from`. */
export function checkHistory(root, currentFrom) {
  const dir = path.join(root, HISTORY_DIR);
  if (!existsSync(dir)) return [`${HISTORY_DIR}: missing; it must chain from ${HISTORY_START} to ${currentFrom}`];
  const errors = [];
  const links = new Map();
  for (const name of readdirSync(dir).sort()) {
    const match = ARCHIVE_NAME.exec(name);
    if (!match) {
      errors.push(`${HISTORY_DIR}/${name}: not a <from>-<to>.json archive`);
      continue;
    }
    const [, from, to] = match;
    if (links.has(from)) errors.push(`${HISTORY_DIR}: two archives start at ${from}`);
    links.set(from, to);
    const bytes = readFileSync(path.join(dir, name));
    const released = tagManifest(root, `v${to}`);
    if (released === null) errors.push(`${HISTORY_DIR}/${name}: tag v${to} has no ${MANIFEST_PATH}; fetch the release tags`);
    else if (!bytes.equals(released)) errors.push(`${HISTORY_DIR}/${name}: differs from ${MANIFEST_PATH} at tag v${to}; an archive is never edited`);
  }
  const seen = new Set();
  let version = HISTORY_START;
  while (links.has(version) && !seen.has(version)) {
    seen.add(version);
    version = links.get(version);
  }
  if (seen.size !== links.size) {
    const loose = [...links].filter(([from]) => !seen.has(from)).map(([from, to]) => `${from}-${to}`);
    errors.push(`${HISTORY_DIR}: ${loose.join(', ')} not on the chain from ${HISTORY_START}`);
  }
  if (version !== currentFrom) errors.push(`${HISTORY_DIR}: the chain from ${HISTORY_START} ends at ${version}, not at the manifest's from ${currentFrom}`);
  return errors;
}
