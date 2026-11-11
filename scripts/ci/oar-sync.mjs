#!/usr/bin/env node
// Writes packages/client/vendor/oar/<base short sha>/ from a commit of the
// Ancienttwo/oar fork branch. The fork branch is where a BYOK change is
// authored; the vendor tree and the manifest's hash columns are its projection.
// Usage: node scripts/ci/oar-sync.mjs --repo <oar clone> --fork <commit> --base <upstream commit>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const FORK_REPOSITORY = 'https://github.com/Ancienttwo/oar';
const DEFAULT_VENDOR_ROOT = fileURLToPath(new URL('../../packages/client/vendor/oar/', import.meta.url));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function syncOar({ repo, fork, base, vendorRoot = DEFAULT_VENDOR_ROOT }) {
  const git = args => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const commit = ref => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString().trim();
  const trees = new Map();
  const tree = sha => {
    if (!trees.has(sha)) trees.set(sha, new Set(git(['ls-tree', '-r', '--name-only', '-z', sha]).toString().split('\0').filter(Boolean)));
    return trees.get(sha);
  };
  const baseSha = commit(base);
  const forkSha = commit(fork);
  try { git(['merge-base', '--is-ancestor', baseSha, forkSha]); } catch {
    throw new Error(`OAR sync: fork commit ${forkSha} does not descend from base ${baseSha}`);
  }

  const dir = path.join(vendorRoot, baseSha.slice(0, 7));
  const manifestPath = path.join(dir, 'source-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const version = JSON.parse(git(['show', `${baseSha}:packages/oar/package.json`]).toString()).version;
  // The release binding is operator-verified (PROVENANCE.md, "Authoritative release binding"); the script only refuses a stale one.
  if (manifest.release?.gitCommit !== baseSha || manifest.release?.version !== version) {
    throw new Error(`OAR sync: ${manifestPath} release binding does not name ${baseSha} (${version}); record it first`);
  }

  const missing = [];
  for (const row of manifest.files) {
    if (!tree(forkSha).has(row.sourcePath)) missing.push(`${row.sourcePath} (fork ${forkSha})`);
    const upstream = row.upstreamCommit ? commit(row.upstreamCommit) : baseSha;
    if (!tree(upstream).has(row.sourcePath)) missing.push(`${row.sourcePath} (upstream ${upstream})`);
  }
  if (missing.length) throw new Error(`OAR sync: manifest paths missing from git:\n${missing.join('\n')}`);

  const rows = manifest.files.map(({ path: file, sourcePath, upstreamCommit, delta }) => {
    const bytes = git(['show', `${forkSha}:${sourcePath}`]);
    const upstreamSha256 = sha256(git(['show', `${upstreamCommit ? commit(upstreamCommit) : baseSha}:${sourcePath}`]));
    const vendoredSha256 = sha256(bytes);
    // Policy: an upstream file differs only for a listed invariant.
    if ((upstreamSha256 !== vendoredSha256) !== Boolean(delta)) {
      throw new Error(`OAR sync: ${file} ${delta ? 'lists a delta but keeps upstream bytes' : 'differs from upstream without a listed delta'}`);
    }
    return { row: { path: file, sourcePath, ...(upstreamCommit && { upstreamCommit }), upstreamSha256, vendoredSha256, ...(delta && { delta }) }, bytes };
  });

  const next = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'fork') continue;
    next[key] = value;
    if (key === 'commit') next.fork = { repository: FORK_REPOSITORY, branch: `byok/${version}`, commit: forkSha };
  }
  Object.assign(next, { packageVersion: version, commit: baseSha, files: rows.map(entry => entry.row) });

  for (const { row, bytes } of rows) {
    const target = path.join(dir, row.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { dir, files: rows.length };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, fork: { type: 'string' }, base: { type: 'string' } } });
  if (!values.repo || !values.fork || !values.base) throw new Error('usage: oar-sync.mjs --repo <oar clone> --fork <commit> --base <upstream commit>');
  const { dir, files } = syncOar(values);
  console.log(`wrote ${files} files and source-manifest.json to ${dir}`);
}
